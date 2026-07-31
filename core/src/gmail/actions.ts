/**
 * Gmail CDP connector — mail TRIAGE verbs (archive / trash / read / star / spam /
 * mute / important / snooze, plus a bounded bulk runner).
 *
 * Companion to cdp-client.ts. That module READS; this one MUTATES, and the
 * difference in blast radius drives every design choice below.
 *
 * ── Rule 0: every mutation must be OBSERVED, never assumed ───────────────────
 * MEASURED 2026-07-29: a synthetic in-page `el.click()` succeeds on hidden and
 * zero-size elements too. So "the click did not throw" proves NOTHING about
 * whether Gmail acted. Worse, Gmail DISABLES toolbar buttons (aria-disabled) when
 * no row is selected, and a click on a disabled button is a silent no-op that
 * still "succeeds". Every verb here therefore:
 *   1. reads a STATE SIGNAL before acting (and short-circuits if already in the
 *      target state — see "Idempotence" below),
 *   2. acts,
 *   3. re-reads the signal and/or matches Gmail's own undo TOAST,
 *   4. reports `verified` honestly. `verified:false` + a `note` is a legitimate
 *      outcome and is NOT an error — it means "the click landed, the state change
 *      could not be confirmed". Mirrors cdp-client's SEND_UNCONFIRMED discipline.
 * Nothing here ever reports a success it did not see.
 *
 * ── Rule 1: every query is VISIBLE-SCOPED ────────────────────────────────────
 * MEASURED 2026-07-29: Gmail RETAINS previous view containers — 3 list tables x
 * 50 rows after inbox -> sent -> search, with only ONE visible, and the stale ones
 * come FIRST in document order. `document.querySelector('tr.zA')` therefore hands
 * you a row from a view the user left. On the read side that returns wrong data;
 * on THIS side it archives the wrong thread. Every row lookup goes through
 * `__vis`; every control lookup goes through `__shown`.
 *
 * ── Rule 2: strategies are explicit, ordered, and self-diagnosing ────────────
 * There is no single reliable affordance for these verbs, so each verb declares
 * an ordered list of STRATEGIES and the runner reports which one worked in
 * `note`. A strategy that cannot find its control returns a structured miss and
 * the next one is tried; the misses are kept and surfaced if all of them fail.
 * "I could not find the control" and "I clicked and nothing changed" are
 * different diagnoses and are reported differently.
 *
 * MEASURED 2026-07-29 (live), which is why the strategy list looks like it does:
 *   - The thread-view toolbar container is `[gh="mtb"]` — confirmed present. BUT
 *     enumerating visible `div[role=button]` inside it yielded exactly ONE
 *     labelled control: "More email options". Archive/Delete/Mark-read/Snooze
 *     were NOT directly-labelled visible buttons there. So "iterate mtb for an
 *     aria-label" MAY legitimately yield nothing — it is a detected MISS, never a
 *     silent no-op.
 *   - In thread view the archive affordance is a LABEL CHIP, not a toolbar
 *     button: `aria-label="Remove label Inbox from this conversation"` (class
 *     `hO`). Gmail archive IS "remove the Inbox label", so this is the real
 *     control. It generalises: "Remove label X from this conversation" is also
 *     the remove-label affordance — a labels module should share
 *     `jsClickRemoveLabelChip()` rather than duplicate it.
 *   - Forcing a 390x844 viewport did NOT flip Gmail to a mobile UI (it clamped to
 *     980px and desktop selectors still returned 50 rows). So there is
 *     deliberately NO viewport branching here. Instead every verb asserts the
 *     desktop UI is present up front and fails with `UNEXPECTED_UI` if it is not,
 *     so an alternate UI surfaces as a loud error rather than "nothing happened".
 *
 * ── Rule 3: idempotence ──────────────────────────────────────────────────────
 * `markRead(id, true)` on an already-read thread SUCCEEDS as a verified no-op; so
 * does starring a starred thread. The pre-read in step 1 is what makes this free.
 *
 * ── Localisation caveat ──────────────────────────────────────────────────────
 * Every control here is matched on its ENGLISH aria-label / tooltip / menu text.
 * A non-English Gmail UI will miss every strategy and report ELEMENT_NOT_FOUND
 * with the labels it looked for — a clear diagnosis, but it will not work. Adding
 * locales means extending LABELS, not changing logic.
 */

/**
 * Minimal CDP surface this module needs. Deliberately NOT imported from
 * cdp-client: the caller wires a live `Cdp` in, and keeping the dependency at one
 * method makes every snippet here unit-testable against a fake page.
 */
interface Cdp {
  evaluate<T = unknown>(expr: string): Promise<T>;
  /**
   * Raw CDP. Optional so this module compiles standalone, but WITHOUT it every
   * toolbar click is synthetic, and Gmail ignores those — see clickCtl.
   */
  send?(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/**
 * NOTE FOR THE WIRE-UP: in-repo this should be
 * `import { GmError } from './cdp-client'` — one error class, not two. It is
 * declared locally only so this module compiles and tests standalone.
 */
export class GmError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Legacy hex thread id, as exposed by `[data-legacy-thread-id]`. */
export type ThreadRef = string;

export interface ActionResult {
  ok: true;
  threadId: string;
  action: string;
  /** True only when the state change (or a Gmail toast) was actually OBSERVED. */
  verified: boolean;
  note?: string;
}

// ─── DOM selectors (single source of truth — fix breakage HERE, never inline) ─

const SELECTORS = {
  /** A thread-list row. Unread rows additionally carry `zE`. VERIFIED. */
  threadRow: 'tr.zA',
  /** Marks a row as unread. VERIFIED. */
  unreadClass: 'zE',
  /** The real server id lives on a descendant of the row. VERIFIED. */
  threadIdAttr: 'data-legacy-thread-id',
  /** A list view has rendered. VERIFIED (via cdp-client). */
  listReady: 'div[role="main"] table, tr.zA',
  /** An open thread has rendered. VERIFIED (via cdp-client). */
  threadReady: 'h2.hP',
  /** Thread-view toolbar container. VERIFIED present 2026-07-29 — but see the
   *  header: it may expose only "More email options" as a labelled control. */
  threadToolbar: '[gh="mtb"]',
  /** List-view toolbar container. CANDIDATE — `[gh="tm"]` is cdp-client's
   *  logged-in probe, and the measured list-toolbar strings (Select / Archive /
   *  Delete / Mark as read / Snooze) were seen on `.at` descendants. Both are
   *  tried, then the whole document as a last resort. */
  listToolbar: '[gh="tm"], .G-atb, .aqK',
  /** Overflow menu opener in the thread toolbar. VERIFIED 2026-07-29. */
  moreBtn: '[aria-label="More email options"], [data-tooltip="More email options"]',
  /** An opened Gmail popup menu. CANDIDATE (`div[role="menu"]` is the ARIA
   *  contract; `.J-M` is Gmail's long-stable menu class). */
  menu: 'div[role="menu"], .J-M',
  /** An item inside an opened menu. CANDIDATE. */
  menuItem: 'div[role="menuitem"], .J-N',
  /** Per-row select checkbox. CANDIDATE — the measured toolbar string "Select"
   *  confirms the affordance exists; the exact node is matched defensively. */
  rowCheckbox: 'div[role="checkbox"], span[role="checkbox"], input[type="checkbox"]',
  /** Star control, in a row and in an open message header. CANDIDATE (`T-KT` is
   *  long-stable; the aria-label is the state signal that actually matters). */
  star: 'span[role="button"][aria-label], div[role="button"][aria-label], .T-KT',
  /** Importance marker in a row / thread. CANDIDATE. */
  importanceMarker: '[aria-label*="mportant"]',
  /** Gmail's undo/confirmation toast. VERIFIED shape (cdp-client uses the same
   *  set for "Message sent"). */
  toast: '.bAq, .vh, [role="alert"], .b8.UC',
  /** Desktop-UI precondition: any ONE of these means we are on the UI these
   *  selectors were measured against. VERIFIED (each verified individually). */
  desktopUi: '[gh="mtb"], [gh="tm"], tr.zA, div[role="button"].T-I.T-I-KE.L3',
} as const;

/**
 * English control labels, as regex SOURCES (anchored where a loose match would be
 * dangerous — `^Delete$` must not match "Delete forever" in Trash view).
 */
const LABELS = {
  archive: ['^Archive$', '^Archive \\('],
  /** Thread view: archive IS "remove the Inbox label". MEASURED. */
  archiveChip: ['^Remove label Inbox from this conversation$'],
  trash: ['^Delete$', '^Move to Trash$', '^Trash$'],
  read: ['^Mark as read$'],
  unread: ['^Mark as unread$'],
  star: ['^Add star$', '^Not starred$', '^Star$'],
  unstar: ['^Remove star$', '^Starred$'],
  spam: ['^Report spam$', '^Report as spam$', '^Mark as spam$'],
  notSpam: ['^Not spam$'],
  mute: ['^Mute$'],
  unmute: ['^Unmute$'],
  important: ['^Mark as important$'],
  notImportant: ['^Mark as not important$'],
  snooze: ['^Snooze$'],
  select: ['^Select$'],
} as const;

/** Snooze presets -> the picker's English item text. CANDIDATE. */
const SNOOZE_TEXT: Record<'tomorrow' | 'later-today' | 'next-week', string[]> = {
  tomorrow: ['^Tomorrow$'],
  'later-today': ['^Later today$'],
  'next-week': ['^Next week$'],
};

/** Toast phrasings that corroborate a given verb. CANDIDATE (English). */
const TOAST = {
  archive: 'archived',
  trash: 'moved to Trash|moved to the Trash|moved to bin',
  spam: 'reported as spam|moved to Spam',
  notSpam: 'not spam|moved to Inbox',
  mute: 'muted',
  unmute: 'unmuted|moved to Inbox',
  snooze: 'snoozed until|Snoozed',
} as const;

// ─── page-side helpers (shared preamble for every snippet) ───────────────────

/**
 * `__vis` is the row scoping contract from cdp-client — a stale view container is
 * `display:none`, so `offsetParent === null` excludes it and its 50 rows.
 *
 * `__shown` is deliberately DIFFERENT and is used for CONTROLS: a Gmail popup
 * menu can be `position: fixed`, for which `offsetParent` is null even while the
 * menu is on screen. Rect size is the primary gate there; scoping a menu lookup
 * with `__vis` would find nothing. Using the wrong one of these two is a silent
 * failure in both directions, hence both are named and documented here.
 */
const JS_VISIBLE = `
  const __vis = (sel, root) => [...(root || document).querySelectorAll(sel)]
    .filter(el => el.offsetParent !== null && el.getBoundingClientRect().height > 0);
  const __shown = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    let pos = 'static';
    try { pos = (window.getComputedStyle(el) || {}).position || 'static'; } catch (e) {}
    return el.offsetParent !== null || pos === 'fixed';
  };
  const __enabled = (el) => !!el && el.getAttribute('aria-disabled') !== 'true'
    && !el.hasAttribute('disabled') && !(el.classList && el.classList.contains('T-I-JW'));
`;

/**
 * Find a control by aria-label / data-tooltip / title, then (second pass only) by
 * its own SHORT text. The two passes matter: matching text first would let a
 * wrapper `div[role=button]` containing a whole toolbar swallow the query, and a
 * click on that wrapper does nothing while looking like a hit.
 *
 * Returns null rather than throwing — a miss is data, not an exception (a throw
 * inside the page becomes an opaque PAGE_EVAL_ERROR and loses the diagnosis).
 */
const JS_FIND_CONTROL = `
  const __ctlText = (el) => {
    const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    return t.length <= 40 ? t : '';
  };
  const __matches = (s, pats) => !!s && pats.some(p => new RegExp(p, 'i').test(s));
  const __findCtl = (pats, root) => {
    const scope = root || document;
    const els = [...scope.querySelectorAll('[aria-label], [data-tooltip], [title], [role="menuitem"], [role="button"], button')]
      .filter(el => __shown(el) && __enabled(el));
    for (const el of els) {
      if (__matches(el.getAttribute('aria-label'), pats)) return el;
      if (__matches(el.getAttribute('data-tooltip'), pats)) return el;
      if (__matches(el.getAttribute('title'), pats)) return el;
    }
    for (const el of els) if (__matches(__ctlText(el), pats)) return el;
    return null;
  };
  const __scope = (sel) => {
    for (const s of sel.split(',')) {
      const hit = [...document.querySelectorAll(s.trim())].filter(__shown)[0];
      if (hit) return hit;
    }
    return null;
  };
`;

/**
 * Resolve the VISIBLE row for a thread id. Returns the row element or null.
 * The id lives on a descendant, not the `tr` — and a stale view holds rows with
 * the SAME id, which is precisely the case `__vis` exists to exclude.
 */
const JS_ROW = `
  const __row = (id) => __vis(${JSON.stringify(SELECTORS.threadRow)})
    .find(tr => {
      const el = tr.querySelector('[' + ${JSON.stringify(SELECTORS.threadIdAttr)} + '="' + id + '"]');
      return !!el;
    }) || null;
`;

/** The full preamble every snippet in this file opens with. */
const JS_PRE = `${JS_VISIBLE}${JS_FIND_CONTROL}${JS_ROW}`;

// ─── state snapshot: the single read every verification is derived from ──────

/**
 * One page read returning EVERY signal a verb might need, so verification costs
 * one round trip instead of one per signal — and, more importantly, so all
 * signals describe the SAME instant. Reading "row gone" and "toast" in two calls
 * lets the toast expire between them and manufactures a phantom failure.
 */
export interface GmailSnapshot {
  hash: string;
  /** 'thread' when an open thread is rendered, 'list' when a thread list is. */
  view: 'thread' | 'list' | 'other';
  /** The open thread is the one we asked about (hash tail or in-thread id). */
  idMatches: boolean;
  rowPresent: boolean;
  rowUnread: boolean | null;
  rowStarred: boolean | null;
  rowImportant: boolean | null;
  /** The "Remove label Inbox from this conversation" chip — thread view only. */
  chipInbox: boolean;
  threadStarred: boolean | null;
  threadImportant: boolean | null;
  /** Text of any currently visible Gmail toast ("Conversation archived", …). */
  toast: string;
}

function jsSnapshot(id: string): string {
  const j = JSON.stringify;
  return `${JS_PRE}
  const id = ${j(id)};
  const row = __row(id);
  const threadOpen = __vis(${j(SELECTORS.threadReady)}).length > 0;
  const listOpen = __vis(${j(SELECTORS.threadRow)}).length > 0;
  const hash = location.hash || '';
  const inThreadId = threadOpen
    ? !!document.querySelector('[' + ${j(SELECTORS.threadIdAttr)} + '="' + id + '"]')
    : false;
  const starOf = (root) => {
    if (!root) return null;
    const els = [...root.querySelectorAll(${j(SELECTORS.star)})].filter(__shown);
    for (const el of els) {
      const s = (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-tooltip') || '');
      if (/^(not starred|add star|star)$/i.test(s.trim())) return false;
      if (/^(starred|remove star)$/i.test(s.trim())) return true;
      if (el.classList && el.classList.contains('T-KT')) {
        if (el.classList.contains('T-KT-Jp')) return true;
      }
    }
    return null;
  };
  const impOf = (root) => {
    if (!root) return null;
    const els = [...root.querySelectorAll(${j(SELECTORS.importanceMarker)})].filter(__shown);
    for (const el of els) {
      const s = (el.getAttribute('aria-label') || '').trim();
      if (/^mark as important$/i.test(s)) return false;
      if (/^mark as not important$/i.test(s)) return true;
    }
    return null;
  };
  const toastEl = [...document.querySelectorAll(${j(SELECTORS.toast)})].filter(__shown);
  return {
    hash: hash,
    view: threadOpen ? 'thread' : (listOpen ? 'list' : 'other'),
    idMatches: inThreadId || (threadOpen && hash.indexOf(id) >= 0),
    rowPresent: !!row,
    rowUnread: row ? row.classList.contains(${j(SELECTORS.unreadClass)}) : null,
    rowStarred: starOf(row),
    rowImportant: impOf(row),
    chipInbox: threadOpen ? !!__findCtl(${j(LABELS.archiveChip)}) : false,
    threadStarred: threadOpen ? starOf(document.querySelector('div[role="main"]') || document.body) : null,
    threadImportant: threadOpen ? impOf(document.querySelector('div[role="main"]') || document.body) : null,
    toast: toastEl.map(e => (e.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).join(' | ').slice(0, 300)
  };`;
}

async function snapshot(cdp: Cdp, id: string): Promise<GmailSnapshot> {
  return await cdp.evaluate<GmailSnapshot>(jsSnapshot(id));
}

// ─── derived signals ─────────────────────────────────────────────────────────

/**
 * A signal reading AND the instrument that produced it.
 *
 * `value: null` means NOT OBSERVABLE from here — never "false". Collapsing the
 * two is how a connector reports "archived" for a thread it never touched.
 *
 * `basis` exists because the pre- and post-readings are often taken in DIFFERENT
 * views: the row said "in inbox", then we opened the thread and the "Remove label
 * Inbox" chip was absent. Read across instruments that looks like proof of
 * archiving, but "no chip" is equally consistent with "the chip selector missed"
 * — a CANDIDATE selector silently becoming a success report. So a state change is
 * only believed when both readings came from the SAME basis; otherwise the verb
 * falls through to its toast or its canonical re-check.
 */
interface Sig {
  value: boolean | null;
  basis: string | null;
}
const NO_SIG: Sig = { value: null, basis: null };

/** Is the thread still in the Inbox? Chip in thread view, row in an inbox list. */
function sigInInbox(s: GmailSnapshot): Sig {
  if (s.view === 'thread' && s.idMatches) return { value: s.chipInbox, basis: 'inbox-chip' };
  if (s.view === 'list' && /^#inbox/.test(s.hash)) return { value: s.rowPresent, basis: 'inbox-row' };
  return NO_SIG;
}

/** Has the thread left the view we are acting in (trash / spam / snooze)? */
function sigGone(s: GmailSnapshot): Sig {
  if (s.view === 'list') return { value: !s.rowPresent, basis: `row-in:${s.hash || '?'}` };
  if (s.view === 'thread' && s.idMatches) return { value: false, basis: `row-in:${s.hash || '?'}` };
  return NO_SIG;
}

function sigUnread(s: GmailSnapshot): Sig {
  if (s.rowUnread !== null) return { value: s.rowUnread, basis: 'row-zE' };
  // An OPEN thread has been read by definition — Gmail marks it read on render.
  if (s.view === 'thread' && s.idMatches) return { value: false, basis: 'thread-open' };
  return NO_SIG;
}

function sigStarred(s: GmailSnapshot): Sig {
  if (s.rowStarred !== null) return { value: s.rowStarred, basis: 'row-star' };
  if (s.view === 'thread' && s.idMatches && s.threadStarred !== null) {
    return { value: s.threadStarred, basis: 'thread-star' };
  }
  return NO_SIG;
}

function sigImportant(s: GmailSnapshot): Sig {
  if (s.rowImportant !== null) return { value: s.rowImportant, basis: 'row-importance' };
  if (s.view === 'thread' && s.idMatches && s.threadImportant !== null) {
    return { value: s.threadImportant, basis: 'thread-importance' };
  }
  return NO_SIG;
}

// ─── navigation + preconditions ──────────────────────────────────────────────

async function waitFor(cdp: Cdp, boolExpr: string, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await cdp.evaluate<boolean>(`return !!(${boolExpr});`)) return true;
    } catch {
      /* transient during navigation */
    }
    if (Date.now() >= deadline) return false;
    await sleep(350);
  }
}

/**
 * Fail LOUDLY when the page is not the desktop Gmail these selectors were
 * measured against. MEASURED 2026-07-29: a 390x844 viewport does NOT flip Gmail
 * to a mobile UI (it clamps to 980px and desktop selectors still return 50 rows),
 * so there is no viewport branching — but an alternate UI must surface as an
 * ERROR, never as a silent "nothing to click".
 */
async function assertDesktopUi(cdp: Cdp): Promise<void> {
  const ok = await cdp.evaluate<boolean>(
    `return !!document.querySelector(${JSON.stringify(SELECTORS.desktopUi)});`,
  );
  if (!ok) {
    throw new GmError(
      'UNEXPECTED_UI',
      'this is not the desktop Gmail UI these selectors were measured against ' +
        `(none of ${SELECTORS.desktopUi} present) — refusing to act blind`,
    );
  }
}

/**
 * Route the SPA by hash. Gmail ignores a hash write that does not change the
 * value, so blank it first when re-entering the same view — otherwise a repeated
 * call silently keeps the previous render and every subsequent read describes the
 * WRONG view (same trap as cdp-client.gotoHash).
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
/**
 * Is the page ACTUALLY showing `hash`, or did the cheap hash write not route?
 *
 * MEASURED 2026-07-31: after writing location.hash='#inbox' the hash still read
 * '#all/<id>' and document.title still said "Drafts (50)". So neither the hash
 * nor "a list is ready" is evidence. Two things ARE:
 *   - document.title carries the view name ("Drafts (50) - ...", "Inbox (2,647) - ...")
 *   - the active nav row gains the class `ain` (drafts active -> "aim ain")
 *
 * This exists so navigation can VERIFY instead of choosing between always
 * trusting (which shipped inbox rows as drafts) and always reloading (which made
 * every view switch a full page load and drove the arrival listener to 148
 * reinstalls). Verify, and reload only when the cheap path demonstrably failed.
 */
const JS_VIEW_MATCHES = (hash: string): string => {
  const label = hash.replace(/^#/, '').split('/')[0].toLowerCase();
  return `const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && e.offsetParent !== null; };
     const want = ${JSON.stringify(label)};
     const active = [...document.querySelectorAll('a[href*="#"]')].filter(vis).some((a) => {
       const h = String(a.getAttribute('href') || '').split('#')[1] || '';
       if (h.split('/')[0].toLowerCase() !== want) return false;
       const row = a.closest('.aim') || a.parentElement;
       return !!row && /(^|\\s)ain(\\s|$)/.test(String(row.className || ''));
     });
     const title = String(document.title || '').toLowerCase();
     const titled = title.indexOf(want) === 0 || title.indexOf(want + ' ') >= 0 || title.indexOf(want + '(') >= 0;
     return active || titled;`;
};

function needsRealLoad(target: string, current: string): boolean {
  if (isRecordHash(target)) return true;
  return String(current || '').trim() !== String(target || '').trim();
}

async function gotoHash(cdp: Cdp, hash: string, readySel: string, timeoutMs = 15000): Promise<void> {
  const h = JSON.stringify(hash);
  const curHash = await cdp.evaluate<string>('return location.hash;').catch(() => '');
  if (needsRealLoad(hash, curHash)) {
    // A record hash only routes on a real document load — see isRecordHash.
    await cdp.evaluate(`location.hash = ${h}; return true;`).catch(() => undefined);
    await sleep(300);
    await cdp.evaluate('location.reload(); return true;').catch(() => undefined);
    await sleep(3200);
  } else {
    await cdp.evaluate(
      `if (location.hash === ${h}) { location.hash = '#__reroute'; await new Promise(r=>setTimeout(r,150)); }
       location.hash = ${h}; return true;`,
    );
    await sleep(900);
  }
  const ready = await waitFor(cdp, `document.querySelector(${JSON.stringify(readySel)})`, timeoutMs);
  if (!ready) throw new GmError('PAGE_NOT_READY', `timed out waiting for ${hash} to render (${readySel})`);
  await sleep(400);
}

async function openThread(cdp: Cdp, id: string): Promise<void> {
  const s = await snapshot(cdp, id);
  if (s.view === 'thread' && s.idMatches) return;
  await gotoHash(cdp, `#all/${encodeURIComponent(id)}`, SELECTORS.threadReady);
}

/** Bounded scroll to render a row that is below the virtualized window. */
async function ensureRowRendered(cdp: Cdp, id: string, maxScrolls = 3): Promise<boolean> {
  for (let i = 0; i <= maxScrolls; i++) {
    const found = await cdp.evaluate<boolean>(`${JS_PRE} return !!__row(${JSON.stringify(id)});`);
    if (found) return true;
    if (i === maxScrolls) return false;
    await cdp.evaluate(
      `const sc = document.querySelector('div[role="main"]') || document.scrollingElement;
       if (sc) sc.scrollBy(0, sc.clientHeight * 1.5); return true;`,
    );
    await sleep(700);
  }
  return false;
}

// ─── page-side click snippets ────────────────────────────────────────────────
//
// Every one of these RETURNS a structured result and never throws inside the
// page: a page-side throw arrives as an opaque PAGE_EVAL_ERROR and destroys the
// diagnosis, which is the only thing that makes a miss actionable.

interface ClickOutcome {
  ok: boolean;
  /** Why it did not click — the whole point of the exercise. */
  miss?: string;
  /** Labels actually present in the scope, for diagnosing a live miss. */
  seen?: string[];
}

/** Click a control by label, optionally scoped to a container selector. */
/** Locate a control by label and return its CENTRE, without clicking. */
function jsFindCtl(labels: readonly string[], scopeSel?: string): string {
  const j = JSON.stringify;
  return `${JS_PRE}
  const scope = ${scopeSel ? `__scope(${j(scopeSel)})` : 'document'};
  if (!scope) return { ok: false, miss: 'scope-not-visible:' + ${j(scopeSel || '')} };
  const seen = [...scope.querySelectorAll('[aria-label], [data-tooltip], [role="menuitem"], [role="button"], button')]
    .filter(el => __shown(el))
    .map(el => (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || (el.textContent || '').trim()).slice(0, 40))
    .filter(Boolean).slice(0, 25);
  const el = __findCtl(${j(labels)}, scope);
  if (!el) return { ok: false, miss: 'no-control-matching:' + ${j(labels.join('|'))}, seen: seen };
  el.scrollIntoView({ block: 'center' });
  await new Promise(r => setTimeout(r, 150));
  const b = el.getBoundingClientRect();
  if (b.width <= 0 || b.height <= 0) return { ok: false, miss: 'control-has-no-box', seen: seen };
  return { ok: true, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), seen: seen };`;
}

/** Locate a row's star control and return its CENTRE, without clicking. */
function jsFindStar(id: string): string {
  const j = JSON.stringify;
  return `${JS_PRE}
  const row = __row(${j(id)});
  if (!row) return { ok: false, miss: 'row-not-visible' };
  const els = [...row.querySelectorAll(${j(SELECTORS.star)})].filter(__shown);
  const star = els.find(el => /^(not starred|starred|add star|remove star|star)$/i
      .test((el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-tooltip') || '').trim()))
    || els.find(el => el.classList && el.classList.contains('T-KT'));
  if (!star) return { ok: false, miss: 'row-has-no-star-control' };
  star.scrollIntoView({ block: 'center' });
  await new Promise(r => setTimeout(r, 150));
  const b = star.getBoundingClientRect();
  if (b.width <= 0 || b.height <= 0) return { ok: false, miss: 'star-has-no-box' };
  return { ok: true, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };`;
}

/** Send a trusted press/release at a point. */
async function dispatchTrustedClick(cdp: Cdp, x: number, y: number): Promise<void> {
  if (typeof cdp.send !== 'function') return;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await sleep(100);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(500);
}

/**
 * Click a control, preferring a TRUSTED mouse event.
 *
 * Falls back to the synthetic click when the transport exposes no raw CDP, so
 * behaviour is never worse than before. A genuine "no control matched" is
 * returned as-is rather than retried synthetically — that is a real miss and its
 * `seen` list is the diagnostic.
 */
async function clickCtl(cdp: Cdp, labels: readonly string[], scopeSel?: string): Promise<ClickOutcome> {
  if (typeof cdp.send === 'function') {
    const box = await cdp
      .evaluate<ClickOutcome & { x?: number; y?: number }>(jsFindCtl(labels, scopeSel))
      .catch(() => ({ ok: false, miss: 'find-threw' }) as ClickOutcome & { x?: number; y?: number });
    if (box.ok && typeof box.x === 'number' && typeof box.y === 'number') {
      await dispatchTrustedClick(cdp, box.x, box.y);
      return { ok: true, seen: box.seen };
    }
    if (typeof box.miss === 'string' && box.miss.indexOf('no-control-matching') === 0) return box;
  }
  return cdp.evaluate<ClickOutcome>(jsClickCtl(labels, scopeSel));
}

/** Click a row's star, preferring a TRUSTED mouse event. */
async function clickStar(cdp: Cdp, id: string): Promise<ClickOutcome> {
  if (typeof cdp.send === 'function') {
    const box = await cdp
      .evaluate<ClickOutcome & { x?: number; y?: number }>(jsFindStar(id))
      .catch(() => ({ ok: false, miss: 'find-threw' }) as ClickOutcome & { x?: number; y?: number });
    if (box.ok && typeof box.x === 'number' && typeof box.y === 'number') {
      await dispatchTrustedClick(cdp, box.x, box.y);
      return { ok: true };
    }
    if (typeof box.miss === 'string' && box.miss !== 'find-threw') return box;
  }
  return cdp.evaluate<ClickOutcome>(jsClickStar(id));
}

function jsClickCtl(labels: readonly string[], scopeSel?: string): string {
  const j = JSON.stringify;
  return `${JS_PRE}
  const scope = ${scopeSel ? `__scope(${j(scopeSel)})` : 'document'};
  if (!scope) return { ok: false, miss: 'scope-not-visible:' + ${j(scopeSel || '')} };
  const seen = [...scope.querySelectorAll('[aria-label], [data-tooltip], [role="menuitem"], [role="button"], button')]
    .filter(el => __shown(el))
    .map(el => (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || (el.textContent || '').trim()).slice(0, 40))
    .filter(Boolean).slice(0, 25);
  const el = __findCtl(${j(labels)}, scope);
  if (!el) return { ok: false, miss: 'no-control-matching:' + ${j(labels.join('|'))}, seen: seen };
  el.scrollIntoView({ block: 'center' });
  await new Promise(r => setTimeout(r, 120));
  el.click();
  return { ok: true, seen: seen };`;
}

/**
 * Click a "Remove label X from this conversation" chip.
 *
 * MEASURED 2026-07-29: in thread view this — not a toolbar button — is the
 * ARCHIVE affordance, because Gmail archive IS "remove the Inbox label"
 * (`aria-label="Remove label Inbox from this conversation"`, class `hO`).
 * Exported so a labels module reuses it for arbitrary labels instead of
 * duplicating the selector knowledge.
 */
export function jsClickRemoveLabelChip(labelName: string): string {
  const pat = `^Remove label ${labelName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} from this conversation$`;
  return jsClickCtl([pat]);
}

/**
 * Tick a row's select checkbox. Verified by re-reading the checkbox state — a
 * synthetic click succeeds on anything, so an unverified "selected" would send
 * the following toolbar click at a DISABLED button (silent no-op).
 */
function jsSelectRow(id: string): string {
  const j = JSON.stringify;
  return `${JS_PRE}
  const row = __row(${j(id)});
  if (!row) return { ok: false, miss: 'row-not-visible' };
  const cb = [...row.querySelectorAll(${j(SELECTORS.rowCheckbox)})].filter(__shown)[0];
  if (!cb) return { ok: false, miss: 'row-has-no-checkbox' };
  const state = (el) => el.getAttribute('aria-checked') === 'true' || el.checked === true
    || (el.closest('tr') && el.closest('tr').classList.contains('x7'));
  if (state(cb)) return { ok: true, seen: ['already-selected'] };
  cb.scrollIntoView({ block: 'center' });
  await new Promise(r => setTimeout(r, 120));
  cb.click();
  await new Promise(r => setTimeout(r, 250));
  if (!state(cb)) return { ok: false, miss: 'checkbox-click-did-not-select' };
  return { ok: true };`;
}

/** Untick whatever is selected, so a failed attempt leaves no armed selection. */
const JS_CLEAR_SELECTION = `${JS_PRE}
  const on = __vis(${JSON.stringify(SELECTORS.threadRow)})
    .flatMap(tr => [...tr.querySelectorAll(${JSON.stringify(SELECTORS.rowCheckbox)})])
    .filter(el => __shown(el) && (el.getAttribute('aria-checked') === 'true' || el.checked === true));
  for (const el of on) el.click();
  return { ok: true, cleared: on.length };`;

/**
 * Open the thread-view overflow menu.
 *
 * MEASURED 2026-07-29: "More email options" was the ONLY labelled visible control
 * inside `[gh="mtb"]`, so for most verbs this menu is not a fallback — it is the
 * primary route. Waits for a menu to actually appear rather than assuming.
 */
const JS_OPEN_MORE = `${JS_PRE}
  const btn = [...document.querySelectorAll(${JSON.stringify(SELECTORS.moreBtn)})].filter(el => __shown(el) && __enabled(el))[0];
  if (!btn) return { ok: false, miss: 'no-more-email-options-button' };
  btn.click();
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 150));
    const menu = [...document.querySelectorAll(${JSON.stringify(SELECTORS.menu)})].filter(__shown)[0];
    if (menu) {
      const seen = [...menu.querySelectorAll(${JSON.stringify(SELECTORS.menuItem)})]
        .filter(__shown).map(el => (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40))
        .filter(Boolean).slice(0, 30);
      return { ok: true, seen: seen };
    }
  }
  return { ok: false, miss: 'more-clicked-but-no-menu-appeared' };`;

/** Click an item inside the currently open menu (Gmail menus are often fixed). */
function jsClickMenuItem(labels: readonly string[]): string {
  const j = JSON.stringify;
  return `${JS_PRE}
  const menu = [...document.querySelectorAll(${j(SELECTORS.menu)})].filter(__shown).pop();
  if (!menu) return { ok: false, miss: 'no-open-menu' };
  const items = [...menu.querySelectorAll(${j(SELECTORS.menuItem)})].filter(el => __shown(el) && __enabled(el));
  const seen = items.map(el => (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40)).filter(Boolean).slice(0, 30);
  const pats = ${j(labels)};
  const hit = items.find(el => __matches((el.getAttribute('aria-label') || '').trim(), pats))
    || items.find(el => __matches((el.textContent || '').replace(/\\s+/g, ' ').trim(), pats));
  if (!hit) return { ok: false, miss: 'no-menu-item-matching:' + ${j(labels.join('|'))}, seen: seen };
  hit.click();
  return { ok: true, seen: seen };`;
}

/** Click a row's star directly — the one control that needs no toolbar at all. */
function jsClickStar(id: string): string {
  const j = JSON.stringify;
  return `${JS_PRE}
  const row = __row(${j(id)});
  if (!row) return { ok: false, miss: 'row-not-visible' };
  const els = [...row.querySelectorAll(${j(SELECTORS.star)})].filter(__shown);
  const star = els.find(el => /^(not starred|starred|add star|remove star|star)$/i
      .test((el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-tooltip') || '').trim()))
    || els.find(el => el.classList && el.classList.contains('T-KT'));
  if (!star) return { ok: false, miss: 'row-has-no-star-control' };
  star.click();
  return { ok: true };`;
}

/**
 * Dispatch a Gmail keyboard shortcut.
 *
 * Third-class strategy on purpose: shortcuts are OFF by default for some
 * accounts, and a synthetic KeyboardEvent may also be ignored. There is no clean
 * "are shortcuts enabled" probe, so this is ordered LAST and its success is
 * decided entirely by the verification step — never by the dispatch returning.
 */
interface KeySpec {
  key: string;
  /** Physical code — NOT derivable from `key` for punctuation shortcuts. */
  code: string;
  keyCode: number;
  shift?: boolean;
}

/**
 * Gmail's shortcut table. `code`/`keyCode` are spelled out because deriving them
 * from the character is wrong exactly where it matters: '#' is Shift+Digit3
 * (keyCode 51), NOT charCode 35 (which is Home) — a derived value dispatches a
 * different key and the shortcut silently never fires.
 */
const KEYS = {
  archive: { key: 'e', code: 'KeyE', keyCode: 69 },
  trash: { key: '#', code: 'Digit3', keyCode: 51, shift: true },
  star: { key: 's', code: 'KeyS', keyCode: 83 },
  read: { key: 'I', code: 'KeyI', keyCode: 73, shift: true },
  unread: { key: 'U', code: 'KeyU', keyCode: 85, shift: true },
  spam: { key: '!', code: 'Digit1', keyCode: 49, shift: true },
  mute: { key: 'm', code: 'KeyM', keyCode: 77 },
  important: { key: '=', code: 'Equal', keyCode: 187 },
  notImportant: { key: '-', code: 'Minus', keyCode: 189 },
} as const satisfies Record<string, KeySpec>;

function jsKey(spec: KeySpec): string {
  const j = JSON.stringify;
  return `${JS_PRE}
  const target = document.activeElement && document.activeElement !== document.body
    ? document.activeElement : (document.querySelector('div[role="main"]') || document.body);
  const tag = (target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || target.isContentEditable) {
    return { ok: false, miss: 'focus-is-in-a-text-field-shortcut-would-be-typed' };
  }
  const init = { key: ${j(spec.key)}, code: ${j(spec.code)}, shiftKey: ${spec.shift === true},
                 keyCode: ${spec.keyCode}, which: ${spec.keyCode}, bubbles: true, cancelable: true };
  for (const type of ['keydown', 'keypress', 'keyup']) {
    document.body.dispatchEvent(new KeyboardEvent(type, init));
  }
  return { ok: true };`;
}

// ─── strategies ──────────────────────────────────────────────────────────────

interface Strategy {
  name: string;
  run(cdp: Cdp, id: string): Promise<ClickOutcome>;
}

const fmtMiss = (o: ClickOutcome) =>
  `${o.miss || 'miss'}${o.seen && o.seen.length ? ` [saw: ${o.seen.slice(0, 8).join(', ')}]` : ''}`;

/**
 * (b) Select the row in the LIST and use the list toolbar.
 * Preferred for mark-as-unread and for star, because strategy (a) has a SIDE
 * EFFECT: opening a thread marks it read.
 */
function stList(labels: readonly string[]): Strategy {
  return {
    name: 'list-toolbar',
    async run(cdp, id) {
      if (!(await ensureRowInSomeList(cdp, id))) return { ok: false, miss: 'row-not-in-inbox-or-all' };
      const sel = await cdp.evaluate<ClickOutcome>(jsSelectRow(id));
      if (!sel.ok) return sel;
      const hit = await clickCtl(cdp, labels, SELECTORS.listToolbar);
      if (hit.ok) return hit;
      // The toolbar container selector is a CANDIDATE; retry unscoped before
      // giving up, then always disarm the selection we just made.
      const wide = await clickCtl(cdp, labels);
      if (!wide.ok) await cdp.evaluate(JS_CLEAR_SELECTION).catch(() => undefined);
      return wide.ok ? { ok: true, seen: wide.seen } : { ok: false, miss: fmtMiss(hit) };
    },
  };
}

/**
 * Make the target row renderable in SOME list, not merely "a list".
 *
 * MEASURED 2026-07-30: the list strategies asked `view !== 'list'` and, if a list
 * was showing, went straight to ensureRowRendered. But after a label/remove or a
 * move the visible list can be one the thread is no longer IN - an emptied label
 * view, for instance - so the row never rendered and the verb quietly did
 * nothing, while the direction that happened to be a no-op still "passed". Being
 * in a list is not the same as being in a list that contains the thread.
 */
async function ensureRowInSomeList(cdp: Cdp, id: string): Promise<boolean> {
  const here = await snapshot(cdp, id);
  if (here.view !== 'list') await gotoHash(cdp, '#inbox', SELECTORS.listReady);
  if (await ensureRowRendered(cdp, id)) return true;
  // The current list does not hold it. #inbox first (the common case), then #all,
  // which holds everything except Trash and Spam.
  for (const hash of ['#inbox', '#all']) {
    await gotoHash(cdp, hash, SELECTORS.listReady).catch(() => undefined);
    if (await ensureRowRendered(cdp, id)) return true;
  }
  return false;
}

/** (a) Open the thread and use its toolbar — `[gh="mtb"]`, which MAY be empty. */
function stThreadToolbar(labels: readonly string[]): Strategy {
  return {
    name: 'thread-toolbar',
    async run(cdp, id) {
      await openThread(cdp, id);
      return await clickCtl(cdp, labels, SELECTORS.threadToolbar);
    },
  };
}

/** (a') Open the thread and click the "Remove label Inbox…" chip. MEASURED. */
function stThreadChip(labels: readonly string[]): Strategy {
  return {
    name: 'thread-label-chip',
    async run(cdp, id) {
      await openThread(cdp, id);
      return await clickCtl(cdp, labels);
    },
  };
}

/** (a'') Open the thread, open "More email options", click the item. */
function stMoreMenu(labels: readonly string[]): Strategy {
  return {
    name: 'thread-more-menu',
    async run(cdp, id) {
      await openThread(cdp, id);
      const opened = await cdp.evaluate<ClickOutcome>(JS_OPEN_MORE);
      if (!opened.ok) return opened;
      const hit = await cdp.evaluate<ClickOutcome>(jsClickMenuItem(labels));
      if (!hit.ok) {
        // Leave no menu open for the next strategy to click through.
        await cdp
          .evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return true;`)
          .catch(() => undefined);
      }
      return hit;
    },
  };
}

/** The row's own star control — no selection, no toolbar. */
const stRowStar: Strategy = {
  name: 'row-star',
  async run(cdp, id) {
    if (!(await ensureRowInSomeList(cdp, id))) return { ok: false, miss: 'row-not-in-inbox-or-all' };
    return await clickStar(cdp, id);
  },
};

/** (c) Keyboard shortcut — LAST, and only believed if verification agrees. */
function stKey(spec: KeySpec): Strategy {
  return {
    name: `keyboard(${spec.shift ? 'shift+' : ''}${spec.key})`,
    async run(cdp, id) {
      await openThread(cdp, id);
      return await cdp.evaluate<ClickOutcome>(jsKey(spec));
    },
  };
}

// ─── the runner: act, then PROVE it ──────────────────────────────────────────

interface Verb {
  action: string;
  /** Derive the tracked signal + its instrument from a snapshot. */
  signal: (s: GmailSnapshot) => Sig;
  signalName: string;
  target: boolean;
  strategies: Strategy[];
  /** Regex source matching Gmail's own undo toast for this verb. */
  toast?: string;
  /** Positive re-observation in a canonical view, used only when inconclusive. */
  confirm?: (cdp: Cdp, id: string) => Promise<{ ok: boolean; how: string }>;
}

/** Navigate to `hash` and report whether the thread's row is there. */
function confirmInView(hash: string, expectPresent: boolean, what: string) {
  return async (cdp: Cdp, id: string): Promise<{ ok: boolean; how: string }> => {
    await gotoHash(cdp, hash, SELECTORS.listReady);
    const present = await ensureRowRendered(cdp, id, expectPresent ? 3 : 1);
    return { ok: present === expectPresent, how: `${what}: row ${present ? 'present' : 'absent'} in ${hash}` };
  };
}

async function runVerb(cdp: Cdp, threadId: string, verb: Verb): Promise<ActionResult> {
  const id = String(threadId || '').trim();
  if (!id) throw new GmError('INVALID_THREAD', 'threadId is required');
  if (!/^[0-9a-zA-Z_-]{6,64}$/.test(id)) {
    // The id is interpolated into a page-side attribute selector; refuse anything
    // that is not an id shape rather than building a selector out of user input.
    throw new GmError('INVALID_THREAD', `"${id}" is not a legacy thread id`);
  }
  await assertDesktopUi(cdp);

  const before = await snapshot(cdp, id);
  const pre = verb.signal(before);
  // Idempotence: already in the target state is a SUCCESS, not an error. Requires
  // an actual reading — `basis === null` means we did not look, not "it is false".
  if (pre.basis !== null && pre.value === verb.target) {
    return {
      ok: true,
      threadId: id,
      action: verb.action,
      verified: true,
      note: `no-op: ${verb.signalName} was already ${verb.target} (observed via ${pre.basis} in ${before.view} view)`,
    };
  }

  const misses: string[] = [];
  for (const st of verb.strategies) {
    let out: ClickOutcome;
    try {
      out = await st.run(cdp, id);
    } catch (e) {
      misses.push(`${st.name}: threw ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!out.ok) {
      misses.push(`${st.name}: ${fmtMiss(out)}`);
      continue;
    }

    await sleep(1500);
    const after = await snapshot(cdp, id);
    const post = verb.signal(after);
    const toastHit = !!verb.toast && new RegExp(verb.toast, 'i').test(after.toast);
    const tried = misses.length ? ` (after ${misses.length} miss(es): ${misses.join('; ')})` : '';

    // Only a SAME-INSTRUMENT comparison is proof — see the `Sig.basis` comment.
    const sameBasis = post.basis !== null && post.basis === pre.basis;

    if (sameBasis && post.value === verb.target) {
      return {
        ok: true,
        threadId: id,
        action: verb.action,
        verified: true,
        note: `strategy=${st.name}; verified: ${verb.signalName}=${post.value} via ${post.basis}${
          toastHit ? ` + toast "${after.toast.slice(0, 80)}"` : ''
        }${tried}`,
      };
    }
    if (toastHit) {
      // Gmail's own undo toast is independent evidence and needs no basis match.
      return {
        ok: true,
        threadId: id,
        action: verb.action,
        verified: true,
        note: `strategy=${st.name}; verified by Gmail toast "${after.toast.slice(0, 80)}" (${verb.signalName} not re-readable on the ${pre.basis || 'unknown'} basis from the ${after.view} view)${tried}`,
      };
    }
    if (sameBasis) {
      // Same instrument, unchanged reading: the click provably did nothing.
      // Safe — and correct — to fall through to the next strategy.
      misses.push(`${st.name}: clicked but ${verb.signalName} still ${post.value} (via ${post.basis})`);
      continue;
    }
    // Inconclusive: we cannot re-read the signal the way we read it before. Try
    // the verb's canonical re-check, which navigates somewhere the instrument
    // exists, before conceding.
    if (verb.confirm) {
      try {
        const c = await verb.confirm(cdp, id);
        if (c.ok) {
          return {
            ok: true, threadId: id, action: verb.action, verified: true,
            note: `strategy=${st.name}; verified by re-observation — ${c.how}${tried}`,
          };
        }
        misses.push(`${st.name}: clicked, but re-observation says it did not take — ${c.how}`);
        continue;
      } catch (e) {
        misses.push(`${st.name}: re-observation failed (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    return {
      ok: true,
      threadId: id,
      action: verb.action,
      verified: false,
      note: `strategy=${st.name} clicked, but ${verb.signalName} could not be re-read on the same basis (pre=${pre.basis || 'none'}, post=${post.basis || 'none'}, view=${after.view}) and no toast matched — STOPPING rather than re-applying, since a second attempt could double-apply or revert a toggle.${tried}`,
    };
  }

  throw new GmError(
    'ACTION_FAILED',
    `${verb.action} did not take on thread ${id}; ${verb.strategies.length} strategies tried — ${misses.join('; ')}`,
  );
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Archive — i.e. REMOVE THE INBOX LABEL, which is what archive literally is.
 * The measured thread-view affordance is the "Remove label Inbox…" chip, so that
 * ranks above the (possibly empty) `[gh="mtb"]` toolbar.
 */
export async function archiveThread(cdp: Cdp, threadId: ThreadRef): Promise<ActionResult> {
  return runVerb(cdp, threadId, {
    action: 'archive',
    signal: sigInInbox,
    signalName: 'inInbox',
    target: false,
    toast: TOAST.archive,
    strategies: [
      stList(LABELS.archive),
      stThreadChip(LABELS.archiveChip),
      stThreadToolbar(LABELS.archive),
      stMoreMenu(LABELS.archive),
      stKey(KEYS.archive),
    ],
    confirm: confirmInView('#inbox', false, 'archived'),
  });
}

/** Move to Trash. Confirmed POSITIVELY (row present in `#trash`), not by absence. */
export async function trashThread(cdp: Cdp, threadId: ThreadRef): Promise<ActionResult> {
  return runVerb(cdp, threadId, {
    action: 'trash',
    signal: sigGone,
    signalName: 'goneFromView',
    target: true,
    toast: TOAST.trash,
    strategies: [
      stList(LABELS.trash),
      stThreadToolbar(LABELS.trash),
      stMoreMenu(LABELS.trash),
      stKey(KEYS.trash),
    ],
    confirm: confirmInView('#trash', true, 'trashed'),
  });
}

/**
 * Mark read / unread.
 *
 * The list strategy is FIRST here for a reason: opening a thread marks it read,
 * so the thread-view route would silently satisfy `read:true` by side effect and
 * would corrupt `read:false` (it would mark read, then unread). Idempotent by
 * construction — an already-read thread returns a verified no-op.
 */
export async function markRead(cdp: Cdp, threadId: ThreadRef, read: boolean): Promise<ActionResult> {
  return runVerb(cdp, threadId, {
    action: read ? 'mark-read' : 'mark-unread',
    signal: sigUnread,
    signalName: 'unread',
    target: !read,
    strategies: read
      ? [stList(LABELS.read), stMoreMenu(LABELS.read), stKey(KEYS.read)]
      : [stList(LABELS.unread), stMoreMenu(LABELS.unread), stKey(KEYS.unread)],
  });
}

/** Star / unstar. The row's own star control needs no selection or toolbar. */
export async function starThread(cdp: Cdp, threadId: ThreadRef, starred: boolean): Promise<ActionResult> {
  return runVerb(cdp, threadId, {
    action: starred ? 'star' : 'unstar',
    signal: sigStarred,
    signalName: 'starred',
    target: starred,
    strategies: [
      // The row star TOGGLES, so it is only safe because runVerb has already
      // confirmed the thread is not in the target state.
      stRowStar,
      stThreadToolbar(starred ? LABELS.star : LABELS.unstar),
      stMoreMenu(starred ? LABELS.star : LABELS.unstar),
      stKey(KEYS.star),
    ],
  });
}

/** Report spam / not spam. "Not spam" is only offered inside the Spam view. */
export async function markSpam(cdp: Cdp, threadId: ThreadRef, spam: boolean): Promise<ActionResult> {
  if (!spam) {
    // Do not pretend the inbox toolbar can un-spam: the control lives in #spam.
    await gotoHash(cdp, '#spam', SELECTORS.listReady).catch(() => undefined);
  }
  return runVerb(cdp, threadId, {
    action: spam ? 'spam' : 'not-spam',
    signal: sigGone,
    signalName: 'goneFromView',
    target: true,
    toast: spam ? TOAST.spam : TOAST.notSpam,
    strategies: spam
      ? [stList(LABELS.spam), stThreadToolbar(LABELS.spam), stMoreMenu(LABELS.spam), stKey(KEYS.spam)]
      : [stList(LABELS.notSpam), stThreadToolbar(LABELS.notSpam), stMoreMenu(LABELS.notSpam)],
    confirm: confirmInView(spam ? '#spam' : '#inbox', true, spam ? 'in-spam' : 'back-in-inbox'),
  });
}

/**
 * Mute / unmute.
 *
 * MEASURED-ADJACENT CAVEAT: mute has NO durable UI state this connector can read
 * — there is no muted view and no row badge — so verification rests on the row
 * leaving the inbox plus Gmail's "Conversation muted" toast. If neither is seen
 * this returns `verified:false` rather than guessing.
 */
export async function muteThread(cdp: Cdp, threadId: ThreadRef, muted: boolean): Promise<ActionResult> {
  return runVerb(cdp, threadId, {
    action: muted ? 'mute' : 'unmute',
    signal: sigGone,
    signalName: 'goneFromView',
    target: muted,
    toast: muted ? TOAST.mute : TOAST.unmute,
    strategies: muted
      ? [stMoreMenu(LABELS.mute), stList(LABELS.mute), stKey(KEYS.mute)]
      : [stMoreMenu(LABELS.unmute), stList(LABELS.unmute)],
  });
}

/** Mark important / not important (the importance marker, not a label). */
export async function markImportant(cdp: Cdp, threadId: ThreadRef, important: boolean): Promise<ActionResult> {
  return runVerb(cdp, threadId, {
    action: important ? 'mark-important' : 'mark-not-important',
    signal: sigImportant,
    signalName: 'important',
    target: important,
    strategies: important
      ? [stList(LABELS.important), stMoreMenu(LABELS.important), stKey(KEYS.important)]
      : [stList(LABELS.notImportant), stMoreMenu(LABELS.notImportant), stKey(KEYS.notImportant)],
  });
}

/**
 * Snooze until a preset. Two clicks, not one: the Snooze control opens a PICKER,
 * and clicking Snooze alone snoozes nothing — so the picker item is treated as
 * part of the strategy and a picker that never opens is a detected miss.
 */
export async function snoozeThread(
  cdp: Cdp,
  threadId: ThreadRef,
  until: 'tomorrow' | 'later-today' | 'next-week',
): Promise<ActionResult> {
  const wanted = SNOOZE_TEXT[until];
  if (!wanted) throw new GmError('INVALID_SNOOZE', `unknown snooze preset "${until}"`);

  const pick = (opener: Strategy): Strategy => ({
    name: `${opener.name}+picker`,
    async run(c, id) {
      const open = await opener.run(c, id);
      if (!open.ok) return open;
      const ready = await waitFor(c, `document.querySelector(${JSON.stringify(SELECTORS.menu)})`, 6000);
      if (!ready) return { ok: false, miss: 'snooze-clicked-but-no-picker-appeared' };
      return await c.evaluate<ClickOutcome>(jsClickMenuItem(wanted));
    },
  });

  return runVerb(cdp, threadId, {
    action: `snooze:${until}`,
    signal: sigGone,
    signalName: 'goneFromView',
    target: true,
    toast: TOAST.snooze,
    strategies: [
      pick(stList(LABELS.snooze)),
      pick(stThreadToolbar(LABELS.snooze)),
      pick(stMoreMenu(LABELS.snooze)),
    ],
    confirm: confirmInView('#snoozed', true, 'snoozed'),
  });
}

/** Hard cap — a triage sweep, not a mailbox migration. */
export const BULK_MAX = 25;

export interface BulkResult {
  done: string[];
  failed: { id: string; error: string }[];
}

/**
 * Run one verb over several threads, sequentially.
 *
 * Two deliberate honesty properties:
 *  - `done` holds ONLY ids whose change was VERIFIED. An unverified success goes
 *    to `failed` with an `UNVERIFIED:` prefix, because a bare list of successes
 *    reads as "all of these definitely happened".
 *  - Ids beyond BULK_MAX are REPORTED as failures, never silently dropped — a cap
 *    that trims the input and returns a short success list is indistinguishable
 *    from partial success.
 * Sequential on purpose: these mutate one shared DOM, and concurrent clicks would
 * race over which view is visible.
 */
export async function bulkAction(
  cdp: Cdp,
  threadIds: string[],
  action: 'archive' | 'trash' | 'read' | 'unread' | 'star' | 'unstar',
): Promise<BulkResult> {
  const runners: Record<typeof action, (id: string) => Promise<ActionResult>> = {
    archive: (id) => archiveThread(cdp, id),
    trash: (id) => trashThread(cdp, id),
    read: (id) => markRead(cdp, id, true),
    unread: (id) => markRead(cdp, id, false),
    star: (id) => starThread(cdp, id, true),
    unstar: (id) => starThread(cdp, id, false),
  };
  const run = runners[action];
  if (!run) throw new GmError('INVALID_ACTION', `unknown bulk action "${action}"`);

  const seen = new Set<string>();
  const ids: string[] = [];
  const done: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const raw of Array.isArray(threadIds) ? threadIds : []) {
    const id = String(raw || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (ids.length >= BULK_MAX) {
      failed.push({ id, error: `BULK_CAP_EXCEEDED: only the first ${BULK_MAX} ids are processed per call` });
      continue;
    }
    ids.push(id);
  }
  if (!ids.length && !failed.length) throw new GmError('INVALID_THREAD', 'threadIds is required');

  for (const id of ids) {
    try {
      const r = await run(id);
      if (r.verified) done.push(id);
      else failed.push({ id, error: `UNVERIFIED: ${r.note || 'acted but could not confirm'}` });
    } catch (e) {
      const code = e instanceof GmError ? e.code : 'ERROR';
      failed.push({ id, error: `${code}: ${e instanceof Error ? e.message : String(e)}` });
    }
    await sleep(400);
  }
  return { done, failed };
}

/** Exported for tests and for a labels module that reuses the chip affordance. */
export const __testing = {
  SELECTORS, LABELS, KEYS, TOAST, SNOOZE_TEXT, JS_PRE,
  jsSnapshot, jsClickCtl, jsSelectRow, jsClickStar, jsClickMenuItem, jsKey,
  JS_OPEN_MORE, JS_CLEAR_SELECTION,
  sigInInbox, sigGone, sigUnread, sigStarred, sigImportant,
};
