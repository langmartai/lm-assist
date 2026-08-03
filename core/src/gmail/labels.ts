/**
 * Gmail labels — READ and WRITE, over CDP.
 *
 * Destination: `core/src/gmail/labels.ts`. Companion to `cdp-client.ts`, which
 * owns the CDP transport; this file owns everything label-shaped.
 *
 * ── What is MEASURED and what is a GUESS ────────────────────────────────────
 * The READ path is measured. The WRITE path is NOT.
 *
 *   READ   (verified live 2026-07-29)
 *     - nav anchors are `a[href*="#label/"]`, and they MUST stay unscoped —
 *       scoping to `div[role="navigation"]` matches NOTHING;
 *     - hrefs nest with `/` and form-encode spaces as `+`
 *       (`#label/4%29+DB:+AUTHORITIES/ACRA`), so SPLIT on `/` BEFORE decoding —
 *       a `%2F` inside one segment is part of the NAME (`HDB/CPF`), not nesting;
 *     - on an OPEN thread, `.at` elements yielded real label names
 *       ["DB: Office Supplies","HY: Zz-Email Test","HY: Microsoft"];
 *     - 🔴 the SAME `.at` on a LIST view yields toolbar junk ("Select",
 *       "Archive", "Mark as read", "Snooze") — so chips are read only once
 *       `h2.hP` proves a thread view, and junk-filtered anyway;
 *     - Gmail RETAINS previous view containers (3 tables x 50 rows, one
 *       visible), so every read is visible-scoped.
 *
 *   WRITE  (NOTHING here has been observed live)
 *     Every control below — the Labels toolbar button, the menu, its filter
 *     input, the item checkboxes, Apply, Archive, the create-label dialog — is a
 *     CANDIDATE. Each is therefore expressed as an ORDERED STRATEGY TABLE, and
 *     every operation reports WHICH strategy matched in its `note`, so the first
 *     live run tells you what is real in one call instead of leaving you to
 *     guess from a silent failure.
 *
 * ── Typing (MEASURED 2026-07-29, the hard way) ──────────────────────────────
 * `Input.insertText` and per-key `Input.dispatchKeyEvent` BOTH land nothing on
 * Gmail's widgets — `el.focus()` does not stick, so keyboard events have no
 * target. (Not the usual headless-unfocused case: `document.hasFocus()` is
 * already true.) The only path that works is the NATIVE VALUE SETTER plus an
 * `input` event, which is what `setMenuFilter()` uses. Do not "fix" it back to
 * keystrokes.
 *
 * Consequence: this file never depends on typing to succeed. The menu is
 * scanned UNFILTERED first, and the filter is only used to reach an item the
 * unfiltered scan could not see.
 *
 * ── Verification policy ─────────────────────────────────────────────────────
 * Every write is checked by RE-READING Gmail, from two independent sources:
 *   (A) the thread's own label chips, re-read after a forced re-route;
 *   (B) the label menu's checkbox state for that label, re-opened fresh.
 * Outcomes are deliberately three-valued, not two:
 *   - confirmed          -> `verified: true`
 *   - observed CONTRARY  -> THROW (we have positive evidence the write failed)
 *   - could not observe  -> `verified: false` + a `note` saying exactly which
 *                           reader went blind. This is not the same as failure
 *                           and must not be reported as one.
 * `removeLabel` additionally requires a WITNESS: it refuses to call an absence
 * "removed" unless the same reader saw the label present beforehand. Otherwise a
 * broken chip selector would certify every removal.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 * - Applying a label that does not exist FAILS LOUDLY with near-matches. It
 *   never creates it: a surprise write the caller cannot undo is worse than an
 *   error.
 * - Creating a label that already exists is a NO-OP SUCCESS.
 * - Trusted Types are ENFORCED on Gmail: no `innerHTML`, no `DOMParser`.
 * - No page snippet may throw. Each returns a typed empty shape instead; a
 *   page-side throw surfaces as PAGE_EVAL_ERROR and tells the caller nothing.
 *
 * ── Merge notes ─────────────────────────────────────────────────────────────
 * - `GmError` and `sleep` below are byte-compatible copies of the ones in
 *   `cdp-client.ts`. On merge, DELETE these and
 *   `import { GmError } from './cdp-client'` — two identically-named classes in
 *   two modules make `instanceof` lie.
 * - Page helpers are prefixed `__l…` (not `__vis`/`__txt`) so a snippet from
 *   this file can be concatenated with one from `cdp-client.ts` without a
 *   page-side redeclaration SyntaxError.
 * - `listLabels()` here supersedes the `listLabels()`/`JS_LABELS` pair in
 *   `cdp-client.ts` (same parsing rules, richer shape: path/nested/numeric
 *   unread). Keep ONE.
 */

// ─── local copies (see Merge notes) ──────────────────────────────────────────

/** MERGE: delete and import from './cdp-client'. */
export class GmError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The only CDP surface this file needs. Deliberately minimal so labels.ts does
 * not import the transport: anything that can evaluate an expression in the
 * Gmail page can drive it (the real client, a test double, a different browser
 * driver). Navigation is done IN-PAGE via the SPA's hash router, which needs no
 * `Page.navigate`.
 */
export interface LabelCdp {
  evaluate<T = unknown>(expr: string): Promise<T>;
  /**
   * Raw CDP. Optional so this module still compiles standalone, but WITHOUT it
   * the toolbar menus cannot be opened at all — Gmail ignores synthetic clicks
   * on them. See trustedClickControl.
   */
  send?(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

// ─── result types ────────────────────────────────────────────────────────────

export interface LabelInfo {
  /** Full label name, nesting joined with `/` (e.g. `4) DB: AUTHORITIES/ACRA`). */
  name: string;
  /** Decoded nesting segments. A segment may itself contain `/` (`HDB/CPF`). */
  path: string[];
  nested: boolean;
  /** Unread count, parsed from the badge or the a11y string. null = not shown. */
  unread: number | null;
}

export interface ApplyResult {
  ok: true;
  /** The label as GMAIL knows it, not the string that was requested. */
  applied: string;
  verified: boolean;
  note?: string;
}

export interface RemoveResult {
  ok: true;
  removed: string;
  verified: boolean;
  note?: string;
}

export interface CreateResult {
  ok: true;
  created: string;
  verified: boolean;
}

/**
 * Result of a label-level operation (rename / delete).
 *
 * Separate from CreateResult on purpose: reusing it would report `created:"X"` for
 * a DELETE, which reads like the opposite of what happened.
 */
export interface LabelOpResult {
  ok: true;
  /** The label the operation ended on — the NEW name after a rename. */
  label: string;
  verified: boolean;
  note?: string;
}

export interface MoveResult {
  ok: true;
  verified: boolean;
  note?: string;
}

/** Tri-state (plus "unknown") checkbox reading from the label menu. */
export type MenuState = 'on' | 'off' | 'mixed' | 'unknown';

export interface MenuItem {
  name: string;
  state: MenuState;
  /** Which page-side rule produced `state` — diagnostic, never load-bearing. */
  stateVia: string;
}

// ─── selectors (single source of truth — fix breakage HERE, never inline) ────

export const LABEL_SELECTORS = {
  // ── nav (READ) ─────────────────────────────────────────────────────────────
  /**
   * VERIFIED 2026-07-29. 🔴 Must stay UNSCOPED: combined with
   * `div[role="navigation"]` it matches nothing.
   */
  navLabel: 'a[href*="#label/"]',
  /** CANDIDATE — the row wrapping a nav anchor, searched for the unread badge. */
  navRow: '.aim, .TO, div[role="listitem"], li',
  /**
   * CANDIDATE — the unread badge.
   * 🔴 Deliberately NOT `[aria-label*="unread" i]`: nav anchors carry
   * "HY: Microsoft, 12 unread messages", so that selector matches the ANCHOR and
   * reading its text reports the LABEL NAME as the count. The a11y string is
   * used, but only through a regex.
   */
  navUnread: '.bsU',

  // ── thread view (READ) ─────────────────────────────────────────────────────
  /** VERIFIED 2026-07-29 — and THE proof that a thread (not a list) is open. */
  threadReady: 'h2.hP',
  /** VERIFIED 2026-07-29 (values) + VERIFIED HAZARD (toolbar junk on list views). */
  threadLabelChip: '.at',
  /**
   * MEASURED 2026-07-30: `.at` matches NOTHING in the current thread view -
   * measured dotAt=0 on a conversation that demonstrably carried three labels.
   * That dead selector is the whole reader gap: label writes landed (Gmail's own
   * toast confirmed them) and then reported verified:false because nothing could
   * read them back.
   *
   * Two live sources, both measured on the same conversation:
   *   the chip:   div.hN[aria-label="Search for all messages with label X"]
   *   the remove: [aria-label="Remove label X from this conversation"]
   * The remove control is preferred - it is the SAME affordance the archive verb
   * already drives ("Remove label Inbox from this conversation"), so it is proven
   * in this codebase, and it names every applied label including system ones.
   */
  threadLabelRemoveBtn: '[aria-label^="Remove label "]',
  threadLabelSearchChip: '[aria-label^="Search for all messages with label "]',
  /** CANDIDATE — preferred scoped shapes, tried before the bare `.at`. */
  threadLabelScoped: '.hN .at, .ha .at, .qh .at, .ar.as .at',
  /** CANDIDATE — the text node inside a chip. */
  threadLabelText: '.av',
  /** VERIFIED HAZARD 2026-07-29 — containers whose `.at` nodes are controls. */
  labelJunkContainers: '[gh], [role="toolbar"], .G-atb, .G-Ni, .aqK',
  /** VERIFIED (inherited from cdp-client.ts) — a list view has rendered. */
  listReady: 'div[role="main"] table, tr.zA, .Cp',

  // ── menus + dialogs (WRITE — all CANDIDATE) ────────────────────────────────
  /** CANDIDATE — any open Gmail menu. `.J-M` is Gmail's long-lived menu class. */
  menu: 'div[role="menu"], .J-M',
  /** CANDIDATE — a menu row that carries a checked state. */
  menuItem: 'div[role="menuitemcheckbox"], div[role="menuitem"], .J-N',
  /** CANDIDATE — the visible text inside a menu row. */
  menuItemText: '.J-N-Jz, .J-N-Jz-Jl',
  /** CANDIDATE — the filter box inside the label menu. */
  menuFilter:
    'input[placeholder*="abel" i], input[aria-label*="abel" i], input.agP, ' +
    'div[role="menu"] input[type="text"], .J-M input[type="text"]',
  /** CANDIDATE — a modal dialog (create-label lives in one). */
  dialog: 'div[role="alertdialog"], div[role="dialog"]',
  /** CANDIDATE — the name field in the create-label dialog. */
  dialogTextInput: 'input[name="newlabel"], input[type="text"]',
  /** CANDIDATE — Gmail's transient status toast ("Added label", "Archived"). */
  toast: '.bAq, .vh, [role="alert"], .b8 .vh, .aT',
} as const;

// ─── control strategy tables ─────────────────────────────────────────────────

/**
 * One way to find a control. Tried in order; the first that resolves a VISIBLE
 * element wins and its `name` is reported back.
 *
 * `sel` is a CSS selector. `text` matches the element's trimmed text /
 * aria-label / data-tooltip / title, case-insensitively, and is additionally
 * required to sit inside `within` when given — a bare text match for "Labels"
 * would otherwise hit the nav's "Labels" SECTION HEADER instead of the toolbar
 * button.
 */
interface CtlStrategy {
  name: string;
  sel?: string;
  text?: readonly string[];
  within?: string;
  /** Always false in this file. Kept so a live-verified entry can be marked. */
  verified: boolean;
}

/** Toolbar containers, used to disambiguate text-matched controls. */
const TOOLBAR_SCOPES: readonly string[] = ['[gh="mtb"]', '[gh="tm"]', '[role="toolbar"]', '.G-atb', '.iH', '.aqK'];
const TOOLBAR_WITHIN = TOOLBAR_SCOPES.join(', ');

/**
 * Build "descendant of ANY of these scopes".
 *
 * 🔴 Do not hand-write `${commaList} div[...]`. CSS binds the descendant
 * combinator to the LAST alternative only, so `A, B C` means "A" OR "B C" — the
 * first alternatives silently match the CONTAINERS themselves. Caught by the
 * fake-DOM harness: the Labels lookup was resolving to the toolbar `div` and
 * clicking it, while confidently reporting a strategy name that had not really
 * matched. A wrong selector that reports a plausible winner is worse than one
 * that misses.
 */
function descendantOfAny(scopes: readonly string[], sel: string): string {
  return scopes.map((s) => `${s} ${sel}`).join(', ');
}

/** The "Labels" toolbar control on an open thread. ALL CANDIDATE. */
const LABELS_BUTTON_STRATEGIES: readonly CtlStrategy[] = [
  { name: 'tooltip-exact', sel: '[data-tooltip="Labels"], [aria-label="Labels"]', verified: false },
  { name: 'tooltip-prefix', sel: '[data-tooltip^="Label"], [aria-label^="Label as"]', verified: false },
  { name: 'act-19', sel: 'div[act="19"], div[act="labels"]', verified: false },
  { name: 'legacy-class', sel: 'div[role="button"].T-I.J-J5-Ji.lR, .ar9', verified: false },
  {
    name: 'haspopup-in-toolbar',
    sel: descendantOfAny(TOOLBAR_SCOPES, 'div[role="button"][aria-haspopup="true"]'),
    verified: false,
  },
  { name: 'text-in-toolbar', text: ['labels', 'label as', 'label'], within: TOOLBAR_WITHIN, verified: false },
];

/** The "Archive" toolbar control. ALL CANDIDATE. */
const ARCHIVE_BUTTON_STRATEGIES: readonly CtlStrategy[] = [
  { name: 'tooltip-exact', sel: '[data-tooltip="Archive"], [aria-label="Archive"]', verified: false },
  { name: 'tooltip-prefix', sel: '[data-tooltip^="Archive"], [aria-label^="Archive"]', verified: false },
  { name: 'act-7', sel: 'div[act="7"], div[act="archive"]', verified: false },
  { name: 'text-in-toolbar', text: ['archive'], within: TOOLBAR_WITHIN, verified: false },
];

/** The "Apply" button at the foot of the label menu. ALL CANDIDATE. */
const APPLY_BUTTON_STRATEGIES: readonly CtlStrategy[] = [
  { name: 'aria-apply', sel: 'div[role="button"][aria-label="Apply"], button[name="ok"]', verified: false },
  { name: 'text-apply', text: ['apply', 'apply changes', 'done', 'ok'], verified: false },
];

/** The entry point that opens the create-label dialog. ALL CANDIDATE. */
const CREATE_ENTRY_STRATEGIES: readonly CtlStrategy[] = [
  {
    name: 'nav-plus',
    sel: '[aria-label="Create new label"], [data-tooltip="Create new label"], [title="Create new label"]',
    verified: false,
  },
  { name: 'text-create-new-label', text: ['create new label'], verified: false },
  { name: 'text-create-new', text: ['create new', 'create label', 'new label'], verified: false },
];

/** The confirm button in the create-label dialog. ALL CANDIDATE. */
const CREATE_CONFIRM_STRATEGIES: readonly CtlStrategy[] = [
  { name: 'button-ok', sel: 'button[name="ok"], div[role="button"][name="ok"]', verified: false },
  { name: 'text-create', text: ['create', 'save', 'ok'], verified: false },
];

// ─── pure helpers (exported: these are what the unit tests exercise) ─────────

/**
 * Decode ONE label-path segment.
 *
 * `+` -> space happens FIRST and separately: `decodeURIComponent` does not do it
 * (that is a form-encoding rule, and Gmail's hrefs are form-encoded).
 * A malformed escape (`%zz`) makes `decodeURIComponent` throw; that must degrade
 * to the raw text, never take down a label read.
 */
export function decodeLabelSegment(seg: string): string {
  const plussed = String(seg).replace(/\+/g, ' ');
  try {
    return decodeURIComponent(plussed);
  } catch {
    return plussed;
  }
}

/**
 * Turn a nav href into a label path.
 *
 * 🔴 SPLIT on `/` BEFORE decoding. Decoding first turns a `%2F` that is part of
 * a NAME (`HDB%2FCPF` -> `HDB/CPF`) into a false nesting separator, which would
 * silently invent a label tree that does not exist.
 *
 * Returns null when the href is not a label route.
 */
export function parseLabelHref(href: string): { name: string; path: string[] } | null {
  const m = String(href || '').match(/#label\/([^?#]+)/);
  if (!m) return null;
  const path = m[1]
    .split('/')
    .map(decodeLabelSegment)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!path.length) return null;
  return { name: path.join('/'), path };
}

/** Comparison key: trimmed, whitespace-collapsed, case-folded. */
export function normalizeLabelKey(s: string): string {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Toolbar strings that appear where labels are expected.
 *
 * The first four are MEASURED on a list view (`.at` returns them verbatim); the
 * rest cover the same toolbars and are defensive, not observed. The length cap
 * catches an accidental match on a whole container's text.
 */
const JUNK_LABEL_TEXTS: readonly string[] = [
  'select',
  'archive',
  'mark as read',
  'snooze',
  'mark as unread',
  'delete',
  'report spam',
  'move to',
  'labels',
  'label as',
  'more',
  'refresh',
  'back to inbox',
  'add to tasks',
  'print all',
  'in new window',
  'show details',
  'hide details',
  'reply',
  'reply all',
  'forward',
  'create new',
  'create new label',
  'manage labels',
  'apply',
  'nest label under',
];

export function isJunkLabelText(t: string): boolean {
  const k = normalizeLabelKey(t);
  return !k || JUNK_LABEL_TEXTS.includes(k) || k.length > 120;
}

/**
 * Parse an unread count out of whatever the badge/a11y string gave us.
 * `"1,234"` -> 1234, `"20+"` -> 20, `"12 unread messages"` -> 12, junk -> null.
 * Never returns a number for a non-count (a label literally named "2024" is
 * excluded upstream by the containment guards in JS_NAV_LABELS).
 */
export function parseUnreadCount(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^([\d,]+)\s*\+?$/) || s.match(/([\d,]+)\s*unread/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Cheap capped Levenshtein — enough to rank near-matches, no dependency. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[n];
}

/** 0..1, higher is closer. Substring containment and leaf hits score high. */
export function labelSimilarity(want: string, candidate: string): number {
  const a = normalizeLabelKey(want);
  const b = normalizeLabelKey(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const leaf = b.split('/').pop() || b;
  if (leaf === a) return 0.95;
  if (b.includes(a) || a.includes(b)) return 0.85;
  if (leaf.includes(a) || a.includes(leaf)) return 0.75;
  const d = editDistance(a, b);
  const ratio = 1 - d / Math.max(a.length, b.length);
  return ratio > 0 ? ratio * 0.7 : 0;
}

/** The closest known names to `want`, best first — for a loud failure message. */
export function nearMatches(want: string, known: readonly string[], limit = 6): string[] {
  return known
    .map((name) => ({ name, score: labelSimilarity(want, name) }))
    .filter((x) => x.score >= 0.35)
    .sort((x, y) => y.score - x.score)
    .slice(0, Math.max(1, limit))
    .map((x) => x.name);
}

export interface LabelResolution {
  /** Exact name as Gmail knows it, or null when nothing matched. */
  match: string | null;
  /** Which rule matched — `full` (whole path) or `leaf` (last segment). */
  via: 'full' | 'leaf' | null;
  /** Populated when nothing matched, or when a leaf match was AMBIGUOUS. */
  candidates: string[];
}

/**
 * Resolve a caller-supplied label against the names Gmail actually has.
 *
 * The caller's string is ambiguous by construction: `Parent/Child` may mean
 * nesting, and a real name may itself contain `/` (MEASURED: `HDB/CPF`). So both
 * readings are tried, most-specific first:
 *   1. exact match on the FULL name  (`4) DB: AUTHORITIES/ACRA`);
 *   2. exact match on the LEAF segment (`ACRA`, `HDB/CPF`) — but ONLY if unique.
 * An ambiguous leaf is NOT resolved to a coin flip: it comes back unmatched with
 * every colliding full name in `candidates`, so the caller is told to qualify it.
 */
export function resolveLabelName(want: string, known: readonly string[]): LabelResolution {
  const key = normalizeLabelKey(want);
  if (!key) return { match: null, via: null, candidates: [] };

  const full = known.filter((n) => normalizeLabelKey(n) === key);
  if (full.length) return { match: full[0], via: 'full', candidates: [] };

  const leaf = known.filter((n) => {
    const segs = n.split('/');
    return normalizeLabelKey(segs[segs.length - 1]) === key;
  });
  if (leaf.length === 1) return { match: leaf[0], via: 'leaf', candidates: [] };
  if (leaf.length > 1) return { match: null, via: null, candidates: leaf };

  return { match: null, via: null, candidates: nearMatches(want, known) };
}

/**
 * The full path a create-label request should ask Gmail for.
 *
 * Gmail creates nesting from a `/`-separated NAME, so `parent` is just a prefix.
 * 🔴 Consequence, and it is not fixable from the UI: a `/` inside `name` is
 * interpreted by Gmail as NESTING. A label whose name literally contains `/`
 * (the measured `HDB/CPF`) cannot be created through this path — it can only be
 * read. `createLabel` documents this rather than pretending otherwise.
 */
export function buildCreatePath(name: string, parent?: string): string {
  const clean = (s: string): string =>
    String(s || '')
      .split('/')
      .map((x) => x.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('/');
  const n = clean(name);
  const p = parent ? clean(parent) : '';
  if (!n) return '';
  return p ? `${p}/${n}` : n;
}

// ─── page-side prelude ───────────────────────────────────────────────────────

/**
 * Shared helpers injected into every snippet below.
 *
 * Named `__l…` on purpose: `cdp-client.ts` declares `__vis`/`__txt`, and two
 * `const` declarations of the same name in one evaluated snippet is a page-side
 * SyntaxError. Prefixing keeps these composable with that file's snippets.
 *
 * `__lVis` is the stale-view guard. Gmail RETAINS previous view containers
 * (measured: 3 list tables x 50 rows, only one visible), so an unscoped
 * `querySelectorAll` returns the PREVIOUS view's nodes first and every read
 * silently answers about the wrong view.
 */
const JS_LBL_PRELUDE = `
  const __lTxt = (el) => el ? String(el.textContent || '').replace(/\\s+/g, ' ').trim() : '';
  const __lShown = (el) => {
    try {
      if (!el || !el.getBoundingClientRect) return false;
      const r = el.getBoundingClientRect();
      return el.offsetParent !== null && r.height > 0 && r.width > 0;
    } catch (e) { return false; }
  };
  const __lAll = (root, sel) => {
    try { return [...(root || document).querySelectorAll(sel)]; } catch (e) { return []; }
  };
  const __lVis = (root, sel) => __lAll(root, sel).filter(__lShown);
  const __lUniq = (a) => [...new Set(a.filter(Boolean))];
  const __lJunk = new Set(${JSON.stringify(JUNK_LABEL_TEXTS)});
  const __lNorm = (t) => String(t == null ? '' : t).replace(/\\s+/g, ' ').trim();
  const __lKey = (t) => __lNorm(t).toLowerCase();
  const __lIsJunk = (t) => { const k = __lKey(t); return !k || __lJunk.has(k) || k.length > 120; };
  const __lInToolbar = (el) => {
    try { return !!(el && el.closest && el.closest(${JSON.stringify(LABEL_SELECTORS.labelJunkContainers)})); }
    catch (e) { return false; }
  };
  /** Text a control can be recognised by, in decreasing reliability. */
  const __lCtlText = (el) => {
    try {
      return [el.getAttribute('aria-label'), el.getAttribute('data-tooltip'),
              el.getAttribute('title'), __lTxt(el)].map(__lKey).filter(Boolean);
    } catch (e) { return []; }
  };
  /**
   * Resolve a control from an ordered strategy table; return the element and the
   * name of the strategy that found it. Reporting the winner is the whole point:
   * with every WRITE selector unverified, "it did not work" is useless, but
   * "tooltip-exact missed, text-in-toolbar hit" is a fix.
   */
  const __lFindCtl = (strats) => {
    for (const st of strats) {
      try {
        if (st.sel) {
          const el = __lVis(document, st.sel)[0];
          if (el) return { el, via: st.name };
        } else if (st.text && st.text.length) {
          const scope = st.within ? __lVis(document, st.within) : [document];
          const want = st.text.map(__lKey);
          for (const root of scope) {
            const cands = __lVis(root, 'div[role="button"], button, span[role="link"], [role="menuitem"], [role="link"], a');
            const hit = cands.find((c) => __lCtlText(c).some((t) => want.includes(t)));
            if (hit) return { el: hit, via: st.name };
          }
        }
      } catch (e) { /* a bad selector must not end the search */ }
    }
    return { el: null, via: null };
  };
  const __lClick = (el) => {
    try {
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    } catch (e) { return false; }
  };
  /**
   * Set an <input>'s value the way a framework notices.
   * MEASURED 2026-07-29: Input.insertText and per-key events BOTH land nothing on
   * Gmail widgets. The native value setter + an 'input' event is the path that
   * works. The extra 'keyup'/'change' are defensive and deliberately carry a
   * harmless key — never Enter, which would submit something we did not choose.
   */
  const __lSetValue = (el, v) => {
    try {
      const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (d && d.set) d.set.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      try { el.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true })); } catch (e2) {}
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return String(el.value == null ? '' : el.value);
    } catch (e) { return null; }
  };
`;

/**
 * Where the SPA currently is, and whether a thread is open.
 * `onThread` is `h2.hP` — the ONLY safe gate for reading `.at` chips.
 */
const JS_LOCATION = `
  ${JS_LBL_PRELUDE}
  try {
    return {
      host: location.hostname,
      hash: location.hash || '',
      onGmail: /(^|\\.)mail\\.google\\.com$/.test(location.hostname),
      onThread: !!__lVis(document, ${JSON.stringify(LABEL_SELECTORS.threadReady)})[0],
      listReady: !!__lVis(document, ${JSON.stringify(LABEL_SELECTORS.listReady)})[0]
    };
  } catch (e) {
    return { host: '', hash: '', onGmail: false, onThread: false, listReady: false };
  }`;

/**
 * The label tree from the left nav.
 *
 * Same parsing rules as the measured READ path, kept in ONE place: split the
 * href on `/` first, then decode each segment (`+` -> space, then
 * decodeURIComponent, guarded). Unread is parsed from the badge or from the a11y
 * string — never from an element's TEXT, because the element carrying
 * "HY: Microsoft, 12 unread messages" is the anchor, whose text is the NAME.
 *
 * Visibility: visible-first with an UNSCOPED fallback. There is exactly one nav,
 * so there are no stale duplicates to confuse; the fallback keeps labels
 * readable when the rail is collapsed (offsetParent null).
 */
const JS_NAV_LABELS = `
  ${JS_LBL_PRELUDE}
  try {
    const dec = (s) => {
      const p = String(s).replace(/\\+/g, ' ');
      try { return decodeURIComponent(p); } catch (e) { return p; }
    };
    let anchors = __lVis(document, ${JSON.stringify(LABEL_SELECTORS.navLabel)});
    if (!anchors.length) anchors = __lAll(document, ${JSON.stringify(LABEL_SELECTORS.navLabel)});
    const seen = new Set();
    const out = [];
    for (const a of anchors) {
      const m = String(a.getAttribute('href') || '').match(/#label\\/([^?#]+)/);
      if (!m) continue;
      const path = m[1].split('/').map(dec).map((x) => x.trim()).filter(Boolean);
      if (!path.length) continue;
      const name = path.join('/');
      if (seen.has(name)) continue;
      seen.add(name);
      let unread = null;
      try {
        const isCount = (t) => /^[\\d,]+\\+?$/.test(String(t == null ? '' : t).trim());
        const row = (a.closest && a.closest(${JSON.stringify(LABEL_SELECTORS.navRow)})) || a.parentElement;
        const badge = a.querySelector(${JSON.stringify(LABEL_SELECTORS.navUnread)})
          || (row ? row.querySelector(${JSON.stringify(LABEL_SELECTORS.navUnread)}) : null);
        if (badge && isCount(__lTxt(badge))) unread = __lTxt(badge);
        if (!unread) {
          for (const s of [a.getAttribute('aria-label'), a.getAttribute('title'),
                           row ? row.getAttribute('aria-label') : null]) {
            const um = String(s == null ? '' : s).match(/([\\d,]+)\\s*unread/i);
            if (um) { unread = um[1]; break; }
          }
        }
        // Class-free last resort: a purely numeric element in the row that is
        // neither the anchor nor contains/contained-by it. The containment guards
        // are what stop a label literally named "2024" reporting itself as a count.
        if (!unread && row) {
          for (const el of __lAll(row, '*')) {
            if (el === a || (a.contains && a.contains(el)) || (el.contains && el.contains(a))) continue;
            if (isCount(__lTxt(el))) { unread = __lTxt(el); break; }
          }
        }
      } catch (e) { unread = null; }
      out.push({ name, path, nested: path.length > 1, unread });
    }
    return out;
  } catch (e) {
    return [];
  }`;

/**
 * The OPEN thread's label chips.
 *
 * 🔴 Gated on `h2.hP`. The same `.at` class on a LIST view is the toolbar
 * ("Select", "Archive", "Mark as read", "Snooze") — MEASURED — so without the
 * gate this returns four fake labels and looks like it worked.
 *
 * Three scopes, narrowest first, and the winner is reported as `via`:
 *   A `threadLabelScoped`             — the classic chip containers;
 *   B walk UP from the subject         — structurally cannot reach the toolbar,
 *                                        which sits ABOVE the thread container;
 *   C bare `.at`                       — only reachable because the subject
 *                                        already proved a thread view, and still
 *                                        junk-filtered and toolbar-excluded.
 */
const JS_THREAD_CHIPS = `
  ${JS_LBL_PRELUDE}
  const __empty = { onThread: false, labels: [], via: null, raw: [] };
  try {
    const subj = __lVis(document, ${JSON.stringify(LABEL_SELECTORS.threadReady)})[0];
    if (!subj) return __empty;
    const read = (nodes) => __lUniq(nodes
      .filter((el) => !__lInToolbar(el))
      .map((el) => __lNorm(el.getAttribute('title') || el.getAttribute('data-tooltip')
        || __lTxt(el.querySelector(${JSON.stringify(LABEL_SELECTORS.threadLabelText)})) || __lTxt(el)))
      .filter((t) => !__lIsJunk(t)));
    let via = null;
    // Strategy 0, MEASURED and preferred: the per-label controls Gmail renders in
    // the open conversation. Scoped to the conversation and visible-only, because
    // Gmail keeps the list mounted behind it and the left nav names every label.
    const __main = subj.closest('div[role="main"]') || document;
    const __inNav = (el) => !!(el.closest('[role="navigation"]') || el.closest('.TO') || el.closest('.aim'));
    let labels = __lUniq(
      __lVis(__main, ${JSON.stringify(LABEL_SELECTORS.threadLabelRemoveBtn)})
        .filter((el) => !__inNav(el))
        .map((el) => {
          const m = /^Remove label (.+) from this conversation$/.exec(el.getAttribute('aria-label') || '');
          return m ? __lNorm(m[1]) : '';
        })
        .filter((t) => t && !__lIsJunk(t)),
    );
    if (labels.length) via = 'remove-control';
    if (!labels.length) {
      labels = __lUniq(
        __lVis(__main, ${JSON.stringify(LABEL_SELECTORS.threadLabelSearchChip)})
          .filter((el) => !__inNav(el))
          .map((el) => {
            const m = /^Search for all messages with label (.+)$/.exec(el.getAttribute('aria-label') || '');
            return m ? __lNorm(m[1]) : '';
          })
          .filter((t) => t && !__lIsJunk(t)),
      );
      if (labels.length) via = 'search-chip';
    }
    if (!labels.length) { labels = read(__lVis(document, ${JSON.stringify(LABEL_SELECTORS.threadLabelScoped)})); if (labels.length) via = 'scoped'; }
    if (!labels.length) {
      let node = subj;
      for (let i = 0; i < 4 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        const hits = __lVis(node, ${JSON.stringify(LABEL_SELECTORS.threadLabelChip)});
        if (hits.length) { const r = read(hits); if (r.length) { labels = r; via = 'subject-ancestor-' + i; break; } }
      }
    }
    if (!labels.length) {
      const r = read(__lVis(document, ${JSON.stringify(LABEL_SELECTORS.threadLabelChip)}));
      if (r.length) { labels = r; via = 'bare-at'; }
    }
    // raw = every visible .at BEFORE filtering. This is how a caller tells
    // "the thread has no labels" from "the chip selector is dead": an empty
    // labels[] with a non-empty raw[] means the filter ate everything.
    const raw = __lVis(document, ${JSON.stringify(LABEL_SELECTORS.threadLabelChip)})
      .map((el) => __lNorm(el.getAttribute('title') || __lTxt(el))).slice(0, 40);
    return { onThread: true, labels: labels.slice(0, 40), via, raw };
  } catch (e) {
    return __empty;
  }`;

/** Gmail's transient status toast — corroboration only, never proof. */
const JS_TOAST = `
  ${JS_LBL_PRELUDE}
  try {
    const t = __lVis(document, ${JSON.stringify(LABEL_SELECTORS.toast)})
      .map(__lTxt).filter((s) => s && s.length < 200);
    return t.length ? t[t.length - 1] : null;
  } catch (e) { return null; }`;

/** Click a control resolved from a strategy table. Returns the winning strategy. */
function jsClickCtl(strategies: readonly CtlStrategy[]): string {
  return `
  ${JS_LBL_PRELUDE}
  try {
    const found = __lFindCtl(${JSON.stringify(strategies)});
    if (!found.el) return { ok: false, via: null };
    const clicked = __lClick(found.el);
    return { ok: clicked, via: found.via };
  } catch (e) {
    return { ok: false, via: null };
  }`;
}

/** Is a menu open, and does it look like the LABEL menu (filter + items)? */
const JS_MENU_STATE = `
  ${JS_LBL_PRELUDE}
  try {
    const menu = __lVis(document, ${JSON.stringify(LABEL_SELECTORS.menu)}).pop() || null;
    if (!menu) return { open: false, items: 0, hasFilter: false };
    return {
      open: true,
      items: __lVis(menu, ${JSON.stringify(LABEL_SELECTORS.menuItem)}).length,
      hasFilter: !!__lVis(menu, ${JSON.stringify(LABEL_SELECTORS.menuFilter)})[0]
    };
  } catch (e) {
    return { open: false, items: 0, hasFilter: false };
  }`;

/**
 * Read every row of the open menu with its checked state.
 *
 * The state is TRI-valued plus unknown, and the distinction matters: Gmail marks
 * a label applied to SOME messages of a thread as `mixed`, and "unknown" (no
 * readable state at all) must never be silently treated as "off" — that would
 * make an unverifiable write look verified.
 */
const JS_MENU_ITEMS = `
  ${JS_LBL_PRELUDE}
  try {
    const menu = __lVis(document, ${JSON.stringify(LABEL_SELECTORS.menu)}).pop();
    if (!menu) return { open: false, items: [] };
    const rows = __lVis(menu, ${JSON.stringify(LABEL_SELECTORS.menuItem)});
    const seen = new Set();
    const items = [];
    for (const row of rows) {
      let name = __lNorm(row.getAttribute('aria-label') || row.getAttribute('title')
        || __lTxt(row.querySelector(${JSON.stringify(LABEL_SELECTORS.menuItemText)})) || __lTxt(row));
      // An aria-label often reads "ACRA, checkbox, checked" — keep the head.
      if (name.includes(',')) {
        const head = __lNorm(name.split(',')[0]);
        if (head) name = head;
      }
      if (__lIsJunk(name)) continue;
      if (seen.has(__lKey(name))) continue;
      seen.add(__lKey(name));
      let state = 'unknown';
      let stateVia = 'none';
      const ac = row.getAttribute('aria-checked');
      if (ac === 'true') { state = 'on'; stateVia = 'aria-checked'; }
      else if (ac === 'false') { state = 'off'; stateVia = 'aria-checked'; }
      else if (ac === 'mixed') { state = 'mixed'; stateVia = 'aria-checked'; }
      if (state === 'unknown') {
        const inner = row.querySelector('[aria-checked]');
        const ic = inner ? inner.getAttribute('aria-checked') : null;
        if (ic === 'true') { state = 'on'; stateVia = 'inner-aria-checked'; }
        else if (ic === 'false') { state = 'off'; stateVia = 'inner-aria-checked'; }
        else if (ic === 'mixed') { state = 'mixed'; stateVia = 'inner-aria-checked'; }
      }
      if (state === 'unknown') {
        const box = row.querySelector('input[type="checkbox"]');
        if (box) { state = box.checked ? 'on' : 'off'; stateVia = 'input-checkbox'; }
      }
      if (state === 'unknown') {
        // Legacy Gmail marks a ticked row with a modifier class on the checkbox
        // span. CANDIDATE and reported as such — never promoted to a fact.
        const legacy = row.querySelector('.J-LC, .J-N-Jz-Jl');
        if (legacy) {
          const cls = String(legacy.getAttribute('class') || '');
          if (/J-LC-J[DW]|checked/i.test(cls)) { state = 'on'; stateVia = 'legacy-class'; }
        }
      }
      items.push({ name, state, stateVia });
    }
    return { open: true, items };
  } catch (e) {
    return { open: false, items: [] };
  }`;

/** Type into the menu's filter box (native setter — see __lSetValue). */
function jsSetMenuFilter(text: string): string {
  return `
  ${JS_LBL_PRELUDE}
  try {
    const menu = __lVis(document, ${JSON.stringify(LABEL_SELECTORS.menu)}).pop();
    const root = menu || document;
    const input = __lVis(root, ${JSON.stringify(LABEL_SELECTORS.menuFilter)})[0];
    if (!input) return { ok: false, value: null, scoped: !!menu };
    try { input.focus(); } catch (e) {}
    const got = __lSetValue(input, ${JSON.stringify(text)});
    return { ok: got !== null, value: got, scoped: !!menu };
  } catch (e) {
    return { ok: false, value: null, scoped: false };
  }`;
}

/**
 * Click the menu row for `name` so its state becomes `want`.
 *
 * Reads the state BEFORE and AFTER the click and returns both. That pair is the
 * first verification gate: if the row did not change state, the click did not
 * register and there is no point clicking Apply — better to fail here than to
 * report a write Gmail never saw.
 *
 * 🔴 `allowUnknown` guards the genuinely dangerous case. A checkbox whose state
 * cannot be read is a TOGGLE of unknown direction: clicking it to "apply" can
 * just as easily REMOVE a label the thread already had. So an unreadable row is
 * only clicked when the caller has established the current state from another
 * source (the thread chips); otherwise the snippet refuses and says so.
 */
function jsClickMenuItem(name: string, want: 'on' | 'off', allowUnknown: boolean): string {
  return `
  ${JS_LBL_PRELUDE}
  const __miss = { ok: false, found: false, matched: null, before: 'unknown', after: 'unknown', autoClosed: false };
  try {
    const menu = __lVis(document, ${JSON.stringify(LABEL_SELECTORS.menu)}).pop();
    if (!menu) return __miss;
    const wantKey = __lKey(${JSON.stringify(name)});
    const leafKey = __lKey(String(${JSON.stringify(name)}).split('/').pop() || '');
    const rows = __lVis(menu, ${JSON.stringify(LABEL_SELECTORS.menuItem)});
    const nameOf = (row) => {
      let n = __lNorm(row.getAttribute('aria-label') || row.getAttribute('title')
        || __lTxt(row.querySelector(${JSON.stringify(LABEL_SELECTORS.menuItemText)})) || __lTxt(row));
      if (n.includes(',')) { const h = __lNorm(n.split(',')[0]); if (h) n = h; }
      return n;
    };
    const stateOf = (row) => {
      const ac = row.getAttribute('aria-checked')
        || (row.querySelector('[aria-checked]') ? row.querySelector('[aria-checked]').getAttribute('aria-checked') : null);
      if (ac === 'true') return 'on';
      if (ac === 'false') return 'off';
      if (ac === 'mixed') return 'mixed';
      const box = row.querySelector('input[type="checkbox"]');
      if (box) return box.checked ? 'on' : 'off';
      return 'unknown';
    };
    let row = rows.find((r) => __lKey(nameOf(r)) === wantKey);
    if (!row && leafKey) row = rows.find((r) => __lKey(nameOf(r)) === leafKey);
    if (!row) return __miss;
    const matched = nameOf(row);
    const before = stateOf(row);
    if (before === 'unknown' && !${JSON.stringify(!!allowUnknown)}) {
      return { ok: false, found: true, matched, before, after: 'unknown', autoClosed: false, unreadable: true };
    }
    if (before === ${JSON.stringify(want)}) {
      // Already in the requested state — clicking would UNDO it. This is the
      // no-op branch, and it is a success, not a miss.
      return { ok: true, found: true, matched, before, after: before, autoClosed: false, noop: true };
    }
    __lClick(row);
    await new Promise((r) => setTimeout(r, 350));
    const stillOpen = !!__lVis(document, ${JSON.stringify(LABEL_SELECTORS.menu)}).pop();
    const after = stillOpen && __lShown(row) ? stateOf(row) : 'unknown';
    return { ok: true, found: true, matched, before, after, autoClosed: !stillOpen, noop: false };
  } catch (e) {
    return __miss;
  }`;
}

/**
 * Commit the menu.
 *
 * Some Gmail builds apply on click and have no Apply button; others require it.
 * Both are handled, and which one happened is reported — an unexplained
 * "nothing applied" is otherwise indistinguishable from a missing selector.
 */
const JS_MENU_APPLY = `
  ${JS_LBL_PRELUDE}
  try {
    const menu = __lVis(document, ${JSON.stringify(LABEL_SELECTORS.menu)}).pop();
    if (!menu) return { clicked: false, via: null, hadMenu: false };
    const strats = ${JSON.stringify(APPLY_BUTTON_STRATEGIES)};
    for (const st of strats) {
      let el = null;
      if (st.sel) el = __lVis(menu, st.sel)[0] || __lVis(document, st.sel)[0] || null;
      else if (st.text) {
        const want = st.text.map(__lKey);
        el = __lVis(menu, 'div[role="button"], button, [role="menuitem"]')
          .find((c) => __lCtlText(c).some((t) => want.includes(t))) || null;
      }
      if (el) { const c = __lClick(el); return { clicked: c, via: st.name, hadMenu: true }; }
    }
    return { clicked: false, via: null, hadMenu: true };
  } catch (e) {
    return { clicked: false, via: null, hadMenu: false };
  }`;

/**
 * Close any open menu without committing anything new.
 * Escape is dispatched on the document (a menu listens there, unlike an input),
 * then an outside pointer sequence — never a click on a menu row, which would
 * toggle a label we did not choose.
 */
const JS_CLOSE_MENU = `
  ${JS_LBL_PRELUDE}
  try {
    for (const type of ['keydown', 'keyup']) {
      document.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 200));
    if (__lVis(document, ${JSON.stringify(LABEL_SELECTORS.menu)}).pop() && document.body) {
      for (const type of ['mousedown', 'mouseup', 'click']) {
        document.body.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 2, clientY: 2 }));
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return { open: !!__lVis(document, ${JSON.stringify(LABEL_SELECTORS.menu)}).pop() };
  } catch (e) {
    return { open: false };
  }`;

/** State of the create-label dialog: open?, what it says, its input's value. */
const JS_DIALOG_STATE = `
  ${JS_LBL_PRELUDE}
  try {
    const dlg = __lVis(document, ${JSON.stringify(LABEL_SELECTORS.dialog)}).pop();
    if (!dlg) return { open: false, text: '', value: null, hasInput: false };
    const input = __lVis(dlg, ${JSON.stringify(LABEL_SELECTORS.dialogTextInput)})[0];
    return {
      open: true,
      text: __lTxt(dlg).slice(0, 400),
      value: input ? String(input.value == null ? '' : input.value) : null,
      hasInput: !!input
    };
  } catch (e) {
    return { open: false, text: '', value: null, hasInput: false };
  }`;

/** Fill the create-label dialog's name field (native setter). */
function jsFillDialog(text: string): string {
  return `
  ${JS_LBL_PRELUDE}
  try {
    const dlg = __lVis(document, ${JSON.stringify(LABEL_SELECTORS.dialog)}).pop();
    if (!dlg) return { ok: false, value: null };
    const input = __lVis(dlg, ${JSON.stringify(LABEL_SELECTORS.dialogTextInput)})[0];
    if (!input) return { ok: false, value: null };
    try { input.focus(); } catch (e) {}
    const got = __lSetValue(input, ${JSON.stringify(text)});
    return { ok: got !== null, value: got };
  } catch (e) {
    return { ok: false, value: null };
  }`;
}

/** Click the dialog's confirm button, scoped to the dialog. */
const JS_DIALOG_CONFIRM = `
  ${JS_LBL_PRELUDE}
  try {
    const dlg = __lVis(document, ${JSON.stringify(LABEL_SELECTORS.dialog)}).pop();
    if (!dlg) return { ok: false, via: null };
    const strats = ${JSON.stringify(CREATE_CONFIRM_STRATEGIES)};
    for (const st of strats) {
      let el = null;
      if (st.sel) el = __lVis(dlg, st.sel)[0] || null;
      else if (st.text) {
        const want = st.text.map(__lKey);
        el = __lVis(dlg, 'div[role="button"], button').find((c) => __lCtlText(c).some((t) => want.includes(t))) || null;
      }
      if (el) return { ok: __lClick(el), via: st.name };
    }
    return { ok: false, via: null };
  } catch (e) {
    return { ok: false, via: null };
  }`;

/** Route the SPA by hash, in-page. Gmail ignores a write of the SAME hash. */
function jsGotoHash(hash: string): string {
  return `
  try {
    if (location.hash === ${JSON.stringify(hash)}) {
      location.hash = '#__lmreroute';
      await new Promise((r) => setTimeout(r, 200));
    }
    location.hash = ${JSON.stringify(hash)};
    return true;
  } catch (e) {
    return false;
  }`;
}

// ─── low-level driver ops ────────────────────────────────────────────────────

interface PageLocation {
  host: string;
  hash: string;
  onGmail: boolean;
  onThread: boolean;
  listReady: boolean;
}

interface ChipRead {
  onThread: boolean;
  labels: string[];
  via: string | null;
  /** Every visible `.at` BEFORE filtering — see JS_THREAD_CHIPS. */
  raw: string[];
}

interface CtlClick {
  ok: boolean;
  via: string | null;
}

interface MenuStateRead {
  open: boolean;
  items: number;
  hasFilter: boolean;
}

interface MenuItemsRead {
  open: boolean;
  items: MenuItem[];
}

interface ItemClickRead {
  ok: boolean;
  found: boolean;
  matched: string | null;
  before: MenuState;
  after: MenuState;
  autoClosed: boolean;
  noop?: boolean;
}

interface DialogRead {
  open: boolean;
  text: string;
  value: string | null;
  hasInput: boolean;
}

/** Poll a page predicate. Transient eval failures during a re-route are ignored. */
async function waitFor(cdp: LabelCdp, expr: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await cdp.evaluate<boolean>(expr)) return true;
    } catch {
      /* the execution context can die mid-navigation; that is not a failure */
    }
    if (Date.now() >= deadline) return false;
    await sleep(350);
  }
}

async function readLocation(cdp: LabelCdp): Promise<PageLocation> {
  return cdp.evaluate<PageLocation>(JS_LOCATION);
}

/**
 * Make sure `#all/<threadId>` is the open thread.
 *
 * Uses the hash router in-page, so this file needs no `Page.navigate`. If the
 * browser is not on Gmail at all we say so plainly rather than driving a
 * cross-origin page — the connector's own entry points own that navigation.
 */
/**
 * Is the requested thread the one actually RENDERED?
 *
 * Scoped to the open conversation and to VISIBLE elements on purpose: Gmail keeps
 * the thread list mounted behind a conversation, so a document-wide scan matches
 * every listed thread's id and would answer true for all of them.
 */
async function threadRendered(cdp: LabelCdp, threadId: string): Promise<boolean> {
  const id = JSON.stringify(threadId);
  return (
    (await cdp
      .evaluate<boolean>(
        `const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.offsetParent !== null; };
         const hdr = [...document.querySelectorAll('h2.hP')].filter(vis)[0];
         if (!hdr) return false;
         const root = hdr.closest('div[role="main"]') || document;
         const ids = [...root.querySelectorAll('[data-legacy-message-id]')].filter(vis)
           .map((e) => e.getAttribute('data-legacy-message-id'));
         const tids = [...root.querySelectorAll('[data-legacy-thread-id]')].filter(vis)
           .map((e) => e.getAttribute('data-legacy-thread-id'));
         return ids.includes(${id}) || tids.includes(${id});`,
      )
      .catch(() => false)) === true
  );
}

async function openThread(cdp: LabelCdp, threadId: string, opts: { force?: boolean } = {}): Promise<void> {
  const id = String(threadId || '').trim();
  if (!id) throw new GmError('INVALID_THREAD', 'threadId is required');

  const loc = await readLocation(cdp);
  if (!loc.onGmail) {
    throw new GmError(
      'NOT_ON_GMAIL',
      `the driver browser is on "${loc.host || 'about:blank'}", not mail.google.com — open Gmail (gmail_status / gmail_login) before driving labels.`,
    );
  }
  // MEASURED 2026-07-30: the hash is not evidence. A hash-only write does NOT
  // re-route Gmail to another conversation — it leaves the PREVIOUS thread
  // rendered while location.hash reads exactly as requested. And on a navigation
  // that does land, Gmail rewrites the hash to its own permalink id, so the hex
  // is no longer in it. `loc.hash.includes(id)` was therefore wrong in both
  // directions: true while showing the wrong thread, false while showing the
  // right one. Ask the DOM instead.
  if (!opts.force && (await threadRendered(cdp, id))) return;

  // Only a real document load routes the SPA to a conversation.
  await cdp.evaluate(`location.hash = ${JSON.stringify(`#all/${encodeURIComponent(id)}`)}; return true;`).catch(() => undefined);
  await sleep(300);
  await reloadPage(cdp);
  await sleep(3000);

  const ready = await waitFor(
    cdp,
    `return !!document.querySelector(${JSON.stringify(LABEL_SELECTORS.threadReady)});`,
    15000,
  );
  if (!ready) {
    throw new GmError('THREAD_NOT_OPEN', `timed out opening thread ${id} (no ${LABEL_SELECTORS.threadReady})`);
  }
  await sleep(600);
  // Prove it is the requested thread before any label verb touches it. Labelling
  // or moving the WRONG conversation is silent and not self-correcting.
  if (!(await threadRendered(cdp, id))) {
    throw new GmError(
      'THREAD_MISMATCH',
      `opened a conversation but it does not carry thread id ${id} — refusing to act on another thread`,
    );
  }
}

/** The nav label tree, as LabelInfo (unread parsed to a number). */
async function readNavLabels(cdp: LabelCdp): Promise<LabelInfo[]> {
  const raw = await cdp.evaluate<Array<{ name: string; path: string[]; nested: boolean; unread: string | null }>>(
    JS_NAV_LABELS,
  );
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => ({
    name: r.name,
    path: Array.isArray(r.path) ? r.path : [r.name],
    nested: !!r.nested,
    unread: parseUnreadCount(r.unread),
  }));
}

/**
 * The open thread's chips.
 *
 * `force` re-routes through `#inbox` first, so the read cannot be answered by a
 * container Gmail has not re-rendered yet — which is exactly the trap when
 * verifying a write that just happened.
 */
async function readThreadChips(cdp: LabelCdp, threadId: string, opts: { force?: boolean } = {}): Promise<ChipRead> {
  if (opts.force) {
    // MEASURED 2026-07-30: this used the hash-only router, which does NOT
    // re-route Gmail away from an open conversation - so the "force" re-read
    // could run against a page that never went anywhere, find no h2.hP, and
    // report chips[none]=(empty) raw=0. That reads identically to "the thread
    // genuinely has no labels", which is exactly how a verified write got
    // reported as unconfirmed. A real document load is the only thing that
    // routes; see isRecordHash in cdp-client.
    await cdp.evaluate(`location.hash = '#inbox'; return true;`).catch(() => undefined);
    await sleep(250);
    await reloadPage(cdp);
    await waitFor(cdp, `return !!document.querySelector(${JSON.stringify(LABEL_SELECTORS.listReady)});`, 12000);
    await sleep(300);
    await openThread(cdp, threadId, { force: true });
  } else {
    await openThread(cdp, threadId);
  }
  // MEASURED 2026-07-30: the per-label controls render AFTER threadReady (h2.hP).
  // Reading immediately returned chips[none]=(empty) on a conversation that
  // demonstrably carried three labels 11s later - and an empty read is
  // indistinguishable from "this thread has no labels", which is precisely how a
  // confirmed write got reported as unverified. Wait for the chip evidence to
  // render, bounded: a genuinely unlabelled thread (e.g. archived, no Inbox chip)
  // has none to wait for, so a timeout here is a legitimate empty, not a failure.
  await waitFor(
    cdp,
    `return !!document.querySelector(${JSON.stringify(LABEL_SELECTORS.threadLabelRemoveBtn)})
        || !!document.querySelector(${JSON.stringify(LABEL_SELECTORS.threadLabelSearchChip)});`,
    6000,
  );
  const r = await cdp.evaluate<ChipRead>(JS_THREAD_CHIPS);
  return r && typeof r === 'object'
    ? { onThread: !!r.onThread, labels: r.labels || [], via: r.via ?? null, raw: r.raw || [] }
    : { onThread: false, labels: [], via: null, raw: [] };
}

async function readToast(cdp: LabelCdp): Promise<string | null> {
  try {
    return await cdp.evaluate<string | null>(JS_TOAST);
  } catch {
    return null;
  }
}

/** Open the Labels menu on the currently open thread. Reports the winner. */
/**
 * Click a toolbar control with a TRUSTED mouse event.
 *
 * MEASURED 2026-07-30: element.click() on the Labels control opens nothing — a
 * before/after diff of every visible container found zero new nodes. The same
 * control clicked through CDP Input.dispatchMouseEvent opens
 * div[role="menu"].J-M.agd.aYO with 79 items. Gmail evidently gates these menus
 * on event.isTrusted, which a synthetic MouseEvent can never satisfy. This is the
 * same class of failure as the recipient field, which ignores synthetic key
 * events and only accepts a native value set.
 *
 * Returns false when no control matched or the transport has no raw CDP, so the
 * caller can still report the honest reason.
 */
async function trustedClickControl(cdp: LabelCdp, labelRe: string): Promise<{ ok: boolean; al: string | null; why?: string }> {
  if (typeof cdp.send !== 'function') return { ok: false, al: null, why: 'this transport exposes no raw CDP, so no trusted event can be sent' };
  const box = await cdp
    .evaluate<{ ok: boolean; x?: number; y?: number; al?: string | null }>(
      `const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.offsetParent !== null; };
       const b = [...document.querySelectorAll('div[role="button"],button')].filter(vis).find((e) => {
         const a = String(e.getAttribute('aria-label') || '').trim();
         const t = String(e.getAttribute('data-tooltip') || '').trim();
         return new RegExp(${JSON.stringify(labelRe)}, 'i').test(a) || new RegExp(${JSON.stringify(labelRe)}, 'i').test(t);
       });
       if (!b) return { ok: false };
       const r = b.getBoundingClientRect();
       return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), al: b.getAttribute('aria-label') };`,
    )
    .catch(() => ({ ok: false }) as { ok: boolean; x?: number; y?: number; al?: string | null });
  if (!box.ok || typeof box.x !== 'number') return { ok: false, al: null, why: `no visible control matching /${labelRe}/i` };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
  await sleep(120);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(70);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(900);
  return { ok: true, al: box.al ?? null };
}

async function openLabelMenu(cdp: LabelCdp, threadId?: string): Promise<{ via: string; items: number; hasFilter: boolean }> {
  const already = await cdp.evaluate<MenuStateRead>(JS_MENU_STATE);
  if (already.open && already.items > 0) return { via: 'already-open', items: already.items, hasFilter: already.hasFilter };

  const click = await cdp.evaluate<CtlClick>(jsClickCtl(LABELS_BUTTON_STRATEGIES));
  if (!click.ok || !click.via) {
    throw new GmError(
      'LABELS_CONTROL_NOT_FOUND',
      `could not find the Labels toolbar control on the open thread — tried ${LABELS_BUTTON_STRATEGIES.map((s) => s.name).join(', ')}. ` +
        'Every one of these is a CANDIDATE selector; capture the toolbar DOM and add the real one to LABELS_BUTTON_STRATEGIES.',
    );
  }
  const opened = await waitFor(
    cdp,
    `const m = [...document.querySelectorAll(${JSON.stringify(LABEL_SELECTORS.menu)})]
       .filter((e) => e.offsetParent !== null && e.getBoundingClientRect().height > 0).pop();
     return !!m && m.querySelectorAll(${JSON.stringify(LABEL_SELECTORS.menuItem)}).length > 0;`,
    6000,
  );
  let st = await cdp.evaluate<MenuStateRead>(JS_MENU_STATE);
  let via = click.via;

  // The synthetic click is expected to fail — Gmail gates this menu on a trusted
  // event. Retry properly before giving up. Kept as a FALLBACK rather than the
  // only path so the module still works over a transport with no raw CDP.
  if (!opened || !st.open) {
    // reselect before the trusted retry: the toolbar controls exist only while a
    // row is checked, and the failed synthetic click may have cleared or moved
    // that state. MEASURED: at retry time no control matched, even though the
    // selection had succeeded moments earlier.
    if (threadId) await selectRowForThread(cdp, threadId).catch(() => false);
    const t = await trustedClickControl(cdp, '^labels?$|^label as');
    if (t.ok) {
      await waitFor(
        cdp,
        `const m = [...document.querySelectorAll(${JSON.stringify(LABEL_SELECTORS.menu)})]
           .filter((e) => e.offsetParent !== null && e.getBoundingClientRect().height > 0).pop();
         return !!m && m.querySelectorAll(${JSON.stringify(LABEL_SELECTORS.menuItem)}).length > 0;`,
        6000,
      );
      st = await cdp.evaluate<MenuStateRead>(JS_MENU_STATE);
      if (st.open) via = `trusted-click(${t.al ?? 'Labels'})`;
    } else if (t.why) {
      throw new GmError(
        'LABEL_MENU_NOT_OPEN',
        `clicked the Labels control (strategy "${click.via}") and the menu stayed shut, and the trusted-event retry could not run: ${t.why}.`,
      );
    }
  }

  if (!st.open) {
    throw new GmError(
      'LABEL_MENU_NOT_OPEN',
      `the Labels control was clicked (strategy "${click.via}") both synthetically and with a trusted mouse event, and no menu with items appeared — the menu selector (${LABEL_SELECTORS.menu}) or the item selector (${LABEL_SELECTORS.menuItem}) is wrong.`,
    );
  }
  return { via, items: st.items, hasFilter: st.hasFilter };
}

async function readMenuItems(cdp: LabelCdp): Promise<MenuItem[]> {
  const r = await cdp.evaluate<MenuItemsRead>(JS_MENU_ITEMS);
  return r && Array.isArray(r.items) ? r.items : [];
}

async function setMenuFilter(cdp: LabelCdp, text: string): Promise<boolean> {
  const r = await cdp.evaluate<{ ok: boolean; value: string | null; scoped: boolean }>(jsSetMenuFilter(text));
  if (!r || !r.ok) return false;
  await sleep(450);
  // The setter reporting the value back is the only proof the widget took it —
  // the measured failure mode here is input that lands NOWHERE and looks fine.
  return (r.value ?? '') === text;
}

async function closeMenu(cdp: LabelCdp): Promise<void> {
  await cdp.evaluate(JS_CLOSE_MENU).catch(() => undefined);
}

/** Menu state for one label, read fresh. This is verification source (B). */
async function readMenuStateFor(cdp: LabelCdp, threadId: string, label: string): Promise<MenuState> {
  try {
    await openThread(cdp, threadId);
    await openLabelMenu(cdp);
    let items = await readMenuItems(cdp);
    let hit = findItem(items, label);
    if (!hit) {
      const leaf = label.split('/').pop() || label;
      if (await setMenuFilter(cdp, leaf)) {
        items = await readMenuItems(cdp);
        hit = findItem(items, label);
      }
    }
    await closeMenu(cdp);
    return hit ? hit.state : 'unknown';
  } catch {
    await closeMenu(cdp);
    return 'unknown';
  }
}

/** Match a menu row to a label by full name, then by leaf. */
function findItem(items: readonly MenuItem[], label: string): MenuItem | null {
  const key = normalizeLabelKey(label);
  const leaf = normalizeLabelKey(label.split('/').pop() || label);
  return (
    items.find((i) => normalizeLabelKey(i.name) === key) ||
    items.find((i) => normalizeLabelKey(i.name) === leaf) ||
    null
  );
}

/**
 * Resolve the caller's label against everything Gmail will admit to having:
 * the nav tree AND the label menu's own rows.
 *
 * Both are needed. The nav omits children of a COLLAPSED parent, so a nav-only
 * lookup would reject a label that exists; the menu can be filtered/virtualised,
 * so a menu-only lookup would too. Failing loudly is required here (a silent
 * create is an unundoable surprise), which makes a false "not found" expensive —
 * hence two sources before refusing.
 */
function resolveAgainst(want: string, navNames: readonly string[], menuNames: readonly string[]): LabelResolution {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const n of [...menuNames, ...navNames]) {
    const k = normalizeLabelKey(n);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    merged.push(n);
  }
  return resolveLabelName(want, merged);
}

/** The loud refusal required when a label does not exist. */
function labelNotFound(want: string, res: LabelResolution, known: readonly string[]): GmError {
  if (res.candidates.length && res.via === null && known.length) {
    const ambiguous = res.candidates.length > 1 && res.candidates.every((c) => c.includes('/'));
    if (ambiguous) {
      return new GmError(
        'LABEL_AMBIGUOUS',
        `"${want}" matches the last segment of ${res.candidates.length} labels: ${res.candidates.join(' | ')}. ` +
          'Pass the full nested name to say which one you mean — refusing to pick for you.',
      );
    }
  }
  const near = res.candidates.length ? res.candidates : nearMatches(want, known);
  return new GmError(
    'LABEL_NOT_FOUND',
    `no Gmail label matches "${want}"` +
      (near.length ? `. Did you mean: ${near.join(' | ')}?` : ` (${known.length} labels read, none close).`) +
      ' Not creating it — use createLabel() explicitly if that is what you want.',
  );
}

// ─── verification ────────────────────────────────────────────────────────────

/** Does a chip list contain `target` (full name, or its leaf)? */
function chipHas(read: ChipRead, target: string): boolean {
  const key = normalizeLabelKey(target);
  const leaf = normalizeLabelKey(target.split('/').pop() || target);
  return read.labels.some((l) => {
    const k = normalizeLabelKey(l);
    return k === key || k === leaf;
  });
}

interface Verdict {
  verified: boolean;
  source: 'thread-chips' | 'label-menu' | 'none';
  note: string;
}

/**
 * Re-read Gmail and decide whether the write actually happened.
 *
 * Three outcomes, and conflating any two of them is how a connector starts
 * lying:
 *   - confirmed            -> verified true, naming the source;
 *   - observed CONTRARY    -> THROW: we have positive evidence it did not take;
 *   - could not observe    -> verified false + a note saying which reader went
 *                             blind. Not a failure, and not a success.
 *
 * For a REMOVAL, absence alone proves nothing — a dead chip selector reports
 * every label as absent. So absence only counts when the SAME reader is known to
 * have seen this label a moment ago (`beforeHadChip`); otherwise the label menu
 * is asked instead.
 */
async function verifyThreadLabel(
  cdp: LabelCdp,
  threadId: string,
  target: string,
  want: 'on' | 'off',
  before: ChipRead,
): Promise<Verdict> {
  const after = await readThreadChips(cdp, threadId, { force: true });
  const hasAfter = chipHas(after, target);
  const chipsAlive = after.labels.length > 0;
  const beforeHadChip = chipHas(before, target);
  const chipNote = `chips[${after.via || 'none'}]=(${after.labels.join(' | ') || 'empty'}) raw=${after.raw.length}`;

  if (want === 'on') {
    if (hasAfter) return { verified: true, source: 'thread-chips', note: chipNote };
    if (chipsAlive) {
      throw new GmError(
        'APPLY_UNVERIFIED',
        `applied "${target}" but re-reading the thread does NOT show it — the write did not take. ${chipNote}`,
      );
    }
  } else {
    if (!hasAfter && beforeHadChip) return { verified: true, source: 'thread-chips', note: chipNote };
    if (hasAfter) {
      throw new GmError(
        'REMOVE_UNVERIFIED',
        `removed "${target}" but re-reading the thread STILL shows it — the write did not take. ${chipNote}`,
      );
    }
    // Absent, but we never saw it present with this reader: absence is not proof.
  }

  // Source A is blind. Ask Gmail's own checkbox.
  const menu = await readMenuStateFor(cdp, threadId, target);
  if (menu === 'unknown') {
    return {
      verified: false,
      source: 'none',
      note:
        `the write was issued and the menu row toggled, but NEITHER reader could confirm it: ${chipNote}, ` +
        'and the label menu did not expose a checkbox state. This is "not observed", not "failed" — ' +
        'confirm in the UI, and add the real chip/checkbox selectors.',
    };
  }
  const menuPresent = menu === 'on' || menu === 'mixed';
  if (menuPresent === (want === 'on')) {
    return { verified: true, source: 'label-menu', note: `${chipNote}; label-menu=${menu}` };
  }
  throw new GmError(
    want === 'on' ? 'APPLY_UNVERIFIED' : 'REMOVE_UNVERIFIED',
    `"${target}" ${want === 'on' ? 'was not applied' : 'was not removed'} — the label menu reports state="${menu}". ${chipNote}`,
  );
}

// ─── the shared write path ───────────────────────────────────────────────────

interface WriteOutcome {
  target: string;
  verified: boolean;
  note: string;
}

/**
 * Drive the label menu to put `label` into state `want` on `threadId`.
 *
 * Order of operations is deliberate:
 *   1. read the thread's chips FIRST — that snapshot is the witness a removal
 *      later needs, and it is worthless if taken after the write;
 *   2. open the menu and scan it UNFILTERED. Typing is the fragile step
 *      (measured: keystrokes land nothing; only the native value setter works),
 *      so the filter is used only when the unfiltered scan cannot see the row;
 *   3. resolve the caller's string against nav + menu names, and REFUSE loudly
 *      if it is not a real label;
 *   4. toggle, checking the row's state changed before bothering with Apply;
 *   5. re-read to verify.
 */
/**
 * Force a real document load.
 *
 * Uses the CDP Page.reload method when the transport exposes raw CDP. The
 * evaluate() form is a fallback and is RACED against a timer on purpose: a
 * reload destroys the execution context the evaluate is running in, so that
 * promise can simply never settle, and an unbounded await there wedges the whole
 * operation rather than failing it.
 */
async function reloadPage(cdp: LabelCdp): Promise<void> {
  if (typeof cdp.send === 'function') {
    await Promise.race([cdp.send('Page.reload', {}).catch(() => undefined), sleep(4000)]);
    return;
  }
  await Promise.race([cdp.evaluate('location.reload(); return true;').catch(() => undefined), sleep(4000)]);
}

/**
 * Put the UI in the state the label and move menus actually require: the LIST
 * view, with this thread's row CHECKED.
 *
 * MEASURED 2026-07-30: the thread view exposes no Labels control at all. Its
 * toolbar offers only "Create new label", "Search for all messages with label
 * Inbox" and "Remove label Inbox from this conversation". Labels
 * (T-I.J-J5-Ji.T-I-Js-Gs), Move to (T-I-Js-IF) and Archive (lR) live on the LIST
 * toolbar and materialise only once a row is checked. setThreadLabel opened the
 * thread and then hunted for a control that is not in that view, which is why
 * every label write failed with LABEL_MENU_NOT_OPEN.
 *
 * The row checkbox DOES respond to a synthetic click (measured: the row gains
 * .x7); it is the toolbar menu buttons that need a trusted event.
 */
/**
 * Check the row for a thread, trying each list view in turn.
 *
 * 🔴 The default views deliberately EXCLUDE Trash and Spam, because Gmail's
 * "All Mail" (#all) excludes them too — a trashed thread is in neither, so a
 * caller wanting one must say so. That is exactly why restoring from Trash
 * needed its own verb: moveToInbox searched #inbox/#all and reported
 * ROW_NOT_SELECTABLE for a thread sitting in #trash the whole time.
 */
async function selectRowForThread(
  cdp: LabelCdp,
  threadId: string,
  hashes: readonly string[] = ['#inbox', '#all'],
): Promise<boolean> {
  for (const hash of hashes) {
    await cdp.evaluate(`location.hash = ${JSON.stringify(hash)}; return true;`).catch(() => undefined);
    await sleep(250);
    // A real load: a hash-only write does not re-route the SPA reliably.
    await reloadPage(cdp);
    await sleep(3000);
    const ok = await cdp
      .evaluate<boolean>(
        `const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.offsetParent !== null; };
         const row = [...document.querySelectorAll('tr.zA')].filter(vis).find((tr) => {
           const el = tr.querySelector('[data-legacy-thread-id]');
           return el && el.getAttribute('data-legacy-thread-id') === ${JSON.stringify(threadId)};
         });
         if (!row) return false;
         const cb = row.querySelector('div[role="checkbox"]');
         if (!cb) return false;
         if (String(row.className).indexOf('x7') < 0) cb.click();
         await new Promise((r) => setTimeout(r, 800));
         return String(row.className).indexOf('x7') >= 0;`,
      )
      .catch(() => false);
    if (ok === true) return true;
  }
  return false;
}

/**
 * Click a MENU ROW with a trusted mouse event.
 *
 * MEASURED 2026-07-30: the same gate that keeps the Labels button shut against a
 * synthetic click also applies to the rows inside the menu — jsClickMenuItem
 * reported the checkbox state stayed "off" after clicking. Gmail accepts the
 * trusted event.
 */
async function trustedClickMenuRow(cdp: LabelCdp, target: string): Promise<boolean> {
  if (typeof cdp.send !== 'function') return false;
  const box = await cdp
    .evaluate<{ ok: boolean; x?: number; y?: number }>(
      `const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.offsetParent !== null; };
       const menu = [...document.querySelectorAll(${JSON.stringify(LABEL_SELECTORS.menu)})].filter(vis).pop();
       if (!menu) return { ok: false };
       const want = ${JSON.stringify(target)}.trim().toLowerCase();
       const leaf = want.split('/').pop();
       const rows = [...menu.querySelectorAll(${JSON.stringify(LABEL_SELECTORS.menuItem)})].filter(vis);
       const norm = (r) => String(r.innerText || '').replace(/\\s+/g, ' ').trim().toLowerCase();
       const row = rows.find((r) => norm(r) === want) || rows.find((r) => norm(r) === leaf) || rows.find((r) => norm(r).indexOf(leaf) >= 0);
       if (!row) return { ok: false };
       const b = row.getBoundingClientRect();
       return { ok: true, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };`,
    )
    .catch(() => ({ ok: false }) as { ok: boolean; x?: number; y?: number });
  if (!box.ok || typeof box.x !== 'number' || typeof box.y !== 'number') return false;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
  await sleep(100);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(800);
  return true;
}

async function setThreadLabel(cdp: LabelCdp, threadId: string, label: string, want: 'on' | 'off'): Promise<WriteOutcome> {
  const wanted = String(label || '').trim();
  if (!wanted) throw new GmError('INVALID_LABEL', 'label is required');

  await openThread(cdp, threadId);
  const before = await readThreadChips(cdp, threadId);
  if (!before.onThread) {
    throw new GmError('THREAD_NOT_OPEN', `thread ${threadId} did not render a thread view (${LABEL_SELECTORS.threadReady})`);
  }

  const nav = await readNavLabels(cdp);
  const navNames = nav.map((l) => l.name);

  // The chips above were read from the thread view; the MENU only exists on the
  // list toolbar with the row checked. See selectRowForThread.
  if (!(await selectRowForThread(cdp, threadId))) {
    throw new GmError(
      'ROW_NOT_SELECTABLE',
      `could not check thread ${threadId}'s row in #inbox or #all — the Labels menu exists only on the LIST toolbar with a row selected, so there is no way to reach it from here`,
    );
  }

  const menu = await openLabelMenu(cdp, threadId);
  const trace: string[] = [`labels-btn=${menu.via}`, `menu-items=${menu.items}`, `menu-filter=${menu.hasFilter}`];

  try {
    let items = await readMenuItems(cdp);
    let res = resolveAgainst(wanted, navNames, items.map((i) => i.name));

    // Not visible unfiltered — the list may be long or virtualised. Type, then rescan.
    if (!res.match) {
      const leaf = wanted.split('/').pop() || wanted;
      const typed = await setMenuFilter(cdp, leaf);
      trace.push(`filter=${typed ? 'set' : 'FAILED'}`);
      if (typed) {
        items = await readMenuItems(cdp);
        res = resolveAgainst(wanted, navNames, items.map((i) => i.name));
      }
    }
    if (!res.match) {
      const known = [...new Set([...items.map((i) => i.name), ...navNames])];
      throw labelNotFound(wanted, res, known);
    }
    const target = res.match;
    trace.push(`resolved=${res.via}`);

    // The row itself must be reachable to click, even if the NAV is what matched.
    if (!findItem(items, target)) {
      const leaf = target.split('/').pop() || target;
      const typed = await setMenuFilter(cdp, leaf);
      trace.push(`filter2=${typed ? 'set' : 'FAILED'}`);
      items = await readMenuItems(cdp);
      if (!findItem(items, target)) {
        throw new GmError(
          'MENU_ITEM_NOT_FOUND',
          `"${target}" exists but the label menu never rendered a row for it (${items.length} rows read${
            typed ? ' after filtering' : '; the filter box could not be set'
          }). The menu-item selector (${LABEL_SELECTORS.menuItem}) is a CANDIDATE — capture the open menu's DOM.`,
        );
      }
    }

    // An UNREADABLE checkbox is not clickable safely: a toggle from an unknown
    // state can do the exact opposite of what was asked. Only proceed when the
    // chips independently establish the current state.
    const chipsAlive = before.labels.length > 0;
    const chipSaysOn = chipHas(before, target);
    const allowUnknown = chipsAlive && chipSaysOn !== (want === 'on');
    if (chipsAlive && chipSaysOn === (want === 'on')) {
      trace.push('already-in-state(chips)');
    }

    const click = await cdp.evaluate<ItemClickRead & { unreadable?: boolean }>(
      jsClickMenuItem(target, want, allowUnknown),
    );
    if (!click || !click.found) {
      throw new GmError('MENU_ITEM_NOT_FOUND', `could not locate the menu row for "${target}" at click time.`);
    }
    if (click.unreadable) {
      throw new GmError(
        'LABEL_STATE_UNREADABLE',
        `refusing to click "${target}": its checkbox state is unreadable (no aria-checked, no input[type=checkbox]) and the ` +
          'thread chips could not establish it either. Clicking a toggle blind can apply the OPPOSITE of what you asked.',
      );
    }
    trace.push(`row=${click.before}->${click.after}${click.noop ? ' (noop)' : ''}`);

    if (!click.noop && !click.autoClosed && click.after !== 'unknown' && click.after !== want) {
      // Gmail ignores the synthetic click on menu rows exactly as it does on the
      // Labels button. Retry with a trusted event and let verifyThreadLabel below
      // be the authority on whether it actually took — asserting here would just
      // be a second reading from the same doubtful source.
      const retried = await trustedClickMenuRow(cdp, target);
      trace.push(`item-trusted-retry=${retried ? 'sent' : 'unavailable'}`);
      if (!retried) {
        throw new GmError(
          'ITEM_TOGGLE_FAILED',
          `clicked the "${target}" row but its state stayed "${click.after}", and no trusted-event retry was possible (this transport exposes no raw CDP) — nothing was applied.`,
        );
      }
    }

    if (!click.autoClosed) {
      const applied = await cdp.evaluate<{ clicked: boolean; via: string | null; hadMenu: boolean }>(JS_MENU_APPLY);
      trace.push(`apply=${applied.clicked ? applied.via : 'none(menu may auto-apply)'}`);
    } else {
      trace.push('apply=auto(menu closed on click)');
    }

    await sleep(900);
    const toast = await readToast(cdp);
    if (toast) trace.push(`toast="${toast.slice(0, 80)}"`);
    await closeMenu(cdp);

    if (click.noop) {
      return {
        target,
        verified: true,
        note: `${trace.join('; ')}; no change needed — Gmail already had it ${want === 'on' ? 'applied' : 'absent'}`,
      };
    }

    const verdict = await verifyThreadLabel(cdp, threadId, target, want, before);
    return { target, verified: verdict.verified, note: `${trace.join('; ')}; verified-by=${verdict.source}; ${verdict.note}` };
  } catch (err) {
    await closeMenu(cdp);
    throw err;
  }
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Every label in the left nav, as a tree.
 *
 * READ path, measured. Note the nav omits children of a COLLAPSED parent, so an
 * absence here is not proof a label does not exist — which is exactly why the
 * write path cross-checks against the label menu before refusing.
 */
export async function listLabels(cdp: LabelCdp): Promise<LabelInfo[]> {
  const loc = await readLocation(cdp);
  if (!loc.onGmail) {
    throw new GmError('NOT_ON_GMAIL', `the driver browser is on "${loc.host || 'about:blank'}", not mail.google.com.`);
  }
  return readNavLabels(cdp);
}

/**
 * The labels currently on one thread.
 *
 * Includes system chips ("Inbox") when Gmail renders them — this reports what is
 * ON the thread, not a filtered opinion of it.
 */
export async function threadLabels(cdp: LabelCdp, threadId: string): Promise<string[]> {
  const read = await readThreadChips(cdp, threadId);
  if (!read.onThread) {
    throw new GmError('THREAD_NOT_OPEN', `thread ${threadId} did not render a thread view (${LABEL_SELECTORS.threadReady})`);
  }
  return read.labels;
}

/**
 * Apply an EXISTING label to a thread.
 *
 * 🔴 A label that does not exist is a LOUD failure with near-matches, never a
 * silent create — a surprise label the caller did not ask for is not undoable
 * from their side.
 */
export async function applyLabel(cdp: LabelCdp, threadId: string, label: string): Promise<ApplyResult> {
  const r = await setThreadLabel(cdp, threadId, label, 'on');
  return { ok: true, applied: r.target, verified: r.verified, note: r.note };
}

/** Remove a label from a thread. Absence is only "removed" with a witness. */
export async function removeLabel(cdp: LabelCdp, threadId: string, label: string): Promise<RemoveResult> {
  const r = await setThreadLabel(cdp, threadId, label, 'off');
  return { ok: true, removed: r.target, verified: r.verified, note: r.note };
}

/**
 * Create a label. Creating one that already exists is a NO-OP SUCCESS.
 *
 * Nesting: Gmail builds the tree from a `/`-separated NAME, so `opts.parent` is
 * simply a prefix and intermediate levels are auto-created.
 * 🔴 The corollary is a real limitation, not an oversight: a `/` inside `name`
 * is read by Gmail as nesting, so a label whose name literally CONTAINS a slash
 * (the measured `HDB/CPF`) can be read by this module but cannot be created by
 * it. There is no UI affordance for escaping it.
 */
/**
 * Open Settings -> Labels and confirm we actually landed there.
 *
 * 🔴 Core's arrival watch and autosync drive the SAME page, so a navigation can be
 * undone before the next evaluate runs — measured repeatedly while building this:
 * a `#settings/labels` request came back reading `#search/in:inbox...`. Re-assert
 * until the hash sticks rather than acting on whichever view happened to win.
 */
/**
 * Poll until the Labels settings table has actually rendered a per-label row.
 *
 * A row is only counted when it carries a "Remove" control, because that is what
 * makes it a LABEL row rather than one of the page's other tables — the same
 * signal the action finder uses, so this waits for exactly what it will read.
 */
async function waitForLabelRows(cdp: LabelCdp, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = await cdp
      .evaluate<number>(`
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.offsetParent !== null; };
        let n = 0;
        for (const tr of [...document.querySelectorAll('tr')].filter(vis)) {
          const acts = [...tr.querySelectorAll('span,a')].filter(vis).map((x) => String(x.innerText || '').trim());
          if (acts.some((t) => /^remove$/i.test(t))) n++;
        }
        return n;`)
      .catch(() => 0);
    if (typeof n === 'number' && n > 0) return true;
    await sleep(400);
  }
  return false;
}

async function openLabelSettings(cdp: LabelCdp): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await cdp
      .evaluate(`location.hash = '#settings/labels'; return true;`)
      .catch(() => undefined);
    await sleep(i === 0 ? 400 : 900);
    await reloadPage(cdp);
    await sleep(i === 0 ? 4000 : 3000);
    const hash = await cdp.evaluate<string>(`return String(location.hash || '');`).catch(() => '');
    if (typeof hash !== 'string' || !/settings\/labels/.test(hash)) continue;
    // 🔴 The hash is not the page. MEASURED 2026-08-03: one second after the
    // reload the hash already read `#settings/labels` while the label table held
    // ZERO rows; it filled in at ~2s. Returning on the hash alone let the caller
    // scan an empty page and conclude the label did not exist. Wait for the thing
    // that is actually going to be read.
    const filled = await waitForLabelRows(cdp, 12000);
    if (filled) return;
  }
  throw new GmError(
    'SETTINGS_NOT_REACHED',
    'could not get the driver browser onto Settings -> Labels (something else may be driving the page)',
  );
}

/**
 * Locate a per-label action link ("edit" / "remove") on the Labels settings page.
 *
 * Two measured traps, both of which silently produce a no-op rather than an error:
 *  - the name cell carries a trailing conversation count ("Paypal 88 conversations"),
 *    so an exact compare against the label name NEVER matches;
 *  - the page is long — the control sat at y≈4700 on a 1080 viewport — so clicking
 *    its raw coordinates lands outside the window and opens nothing.
 */
function jsFindLabelAction(name: string, action: 'edit' | 'remove'): string {
  const j = JSON.stringify;
  return `
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.offsetParent !== null; };
  const rows = [...document.querySelectorAll('tr')].filter(vis);
  const seen = [];
  for (const tr of rows) {
    const raw = String((tr.querySelector('td') || {}).innerText || '').replace(/\\s+/g, ' ').trim();
    const cell = raw.replace(/\\s*\\d+\\s+conversations?$/i, '').trim();
    if (!cell) continue;
    const acts = [...tr.querySelectorAll('span,a')].filter(vis).map((x) => String(x.innerText || '').trim());
    if (acts.some((t) => /^remove$/i.test(t))) seen.push(cell);
    if (cell !== ${j(name)}) continue;
    const hit = [...tr.querySelectorAll('span,a')].filter(vis)
      .find((x) => String(x.innerText || '').trim().toLowerCase() === ${j(action)});
    if (!hit) return { ok: false, miss: 'row-found-but-no-' + ${j(action)}, acts: acts.slice(0, 8) };
    hit.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 500));
    const b = hit.getBoundingClientRect();
    if (b.top < 0 || b.bottom > innerHeight) return { ok: false, miss: 'off-screen-after-scroll' };
    return { ok: true, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  }
  // 🔴 EMPTY IS NOT ABSENT. Zero readable label rows means the settings table did
  // not render, not that the account has no labels — and on an account with 71 of
  // them the difference is the whole answer. Reporting it as 'no-such-label' is how
  // "it has: (none read)" ended up in a LABEL_NOT_FOUND on a label that existed.
  if (!seen.length) return { ok: false, miss: 'labels-unreadable' };
  return { ok: false, miss: 'no-such-label', seen: seen.slice(0, 25) };`;
}

/** Read the settings dialog that a label action opens. */
const JS_LABEL_DIALOG = `
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.offsetParent !== null; };
  const d = [...document.querySelectorAll('div[role="alertdialog"],div[role="dialog"]')].filter(vis).pop();
  if (!d) return { ok: false };
  const input = [...d.querySelectorAll('input[type="text"],input:not([type])')].filter(vis)[0] || null;
  const buttons = [...d.querySelectorAll('button,div[role="button"]')].filter(vis)
    .map((b) => String(b.innerText || '').trim()).filter(Boolean);
  return { ok: true, text: String(d.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
           hasInput: !!input, value: input ? String(input.value || '') : null, buttons: buttons.slice(0, 6) };`;

/** Click a button inside the open settings dialog, by exact label. */
function jsClickDialogButton(label: string): string {
  const j = JSON.stringify;
  return `
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.offsetParent !== null; };
  const d = [...document.querySelectorAll('div[role="alertdialog"],div[role="dialog"]')].filter(vis).pop();
  if (!d) return { ok: false, miss: 'no-dialog' };
  const btns = [...d.querySelectorAll('button,div[role="button"]')].filter(vis);
  const hit = btns.find((b) => String(b.innerText || '').trim().toLowerCase() === ${j(label.toLowerCase())});
  if (!hit) return { ok: false, miss: 'no-button', saw: btns.map((b) => String(b.innerText || '').trim()).slice(0, 6) };
  hit.scrollIntoView({ block: 'center' });
  await new Promise((r) => setTimeout(r, 200));
  const b = hit.getBoundingClientRect();
  return { ok: true, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };`;
}

/** Replace the dialog input's text. */
function jsSetDialogInput(value: string): string {
  const j = JSON.stringify;
  return `
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.offsetParent !== null; };
  const d = [...document.querySelectorAll('div[role="alertdialog"],div[role="dialog"]')].filter(vis).pop();
  if (!d) return { ok: false, miss: 'no-dialog' };
  const input = [...d.querySelectorAll('input[type="text"],input:not([type])')].filter(vis)[0];
  if (!input) return { ok: false, miss: 'no-input' };
  input.focus();
  // Drive the NATIVE setter: assigning .value directly is invisible to a framework
  // that tracks its own state, and the dialog would save the OLD name.
  const proto = Object.getPrototypeOf(input);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(input, ${j(value)}); else input.value = ${j(value)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, now: String(input.value || '') };`;
}

/** One trusted click at a point produced by the helpers above. */
async function trustedAt(cdp: LabelCdp, x: number, y: number): Promise<void> {
  if (typeof cdp.send !== 'function') return;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await sleep(100);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(600);
}

interface ActionPoint {
  ok: boolean;
  x?: number;
  y?: number;
  miss?: string;
  seen?: string[];
  acts?: string[];
}

/** Open a label's settings dialog and leave it open. Shared by rename and delete. */
async function openLabelDialog(cdp: LabelCdp, name: string, action: 'edit' | 'remove'): Promise<void> {
  if (typeof cdp.send !== 'function') {
    throw new GmError('NO_RAW_CDP', 'label settings need trusted clicks, which need raw CDP on this transport');
  }
  await openLabelSettings(cdp);
  const pt = await cdp.evaluate<ActionPoint>(jsFindLabelAction(name, action));
  if (!pt?.ok || typeof pt.x !== 'number' || typeof pt.y !== 'number') {
    if (pt?.miss === 'labels-unreadable') {
      throw new GmError(
        'LABELS_UNREADABLE',
        'the Labels settings page rendered no label rows, so whether "' +
          name +
          '" exists is UNKNOWN — this is not a report that it is missing. ' +
          'Usually the page was navigated away mid-read (the background sync drives the same tab); retry.',
      );
    }
    if (pt?.miss === 'no-such-label') {
      // Name what DOES exist — "not found" against an invisible list is unactionable,
      // and a nested label's real name is its full path ("Parent/Child").
      throw new GmError(
        'LABEL_NOT_FOUND',
        `no user label named "${name}" on the Labels settings page; it has: ${(pt.seen || []).join(', ') || '(none read)'}`,
      );
    }
    throw new GmError('LABEL_ACTION_NOT_FOUND', `could not reach "${action}" for label "${name}": ${pt?.miss || 'unknown'}`);
  }
  await trustedAt(cdp, pt.x, pt.y);
  await sleep(1200);
  const dlg = await cdp.evaluate<{ ok: boolean }>(JS_LABEL_DIALOG);
  if (!dlg?.ok) throw new GmError('LABEL_DIALOG_NOT_OPEN', `clicking "${action}" for "${name}" opened no dialog`);
}

/**
 * Rename a label.
 *
 * MEASURED 2026-08-01: the edit dialog is `role="alertdialog"` reading
 * "Edit label / Label name: / Nest label under: / Cancel Save", with the current
 * name pre-filled in a single text input.
 */
export async function renameLabel(cdp: LabelCdp, from: string, to: string): Promise<LabelOpResult> {
  const src = String(from || '').trim();
  const dst = String(to || '').trim();
  if (!src || !dst) throw new GmError('INVALID_LABEL', 'both the current name and the new name are required');
  if (src === dst) throw new GmError('INVALID_LABEL', `"${src}" is already the name — nothing to rename`);

  await openLabelDialog(cdp, src, 'edit');
  const set = await cdp.evaluate<{ ok: boolean; miss?: string; now?: string }>(jsSetDialogInput(dst));
  if (!set?.ok) throw new GmError('LABEL_RENAME_FAILED', `could not type the new name: ${set?.miss || 'unknown'}`);

  const save = await cdp.evaluate<ActionPoint>(jsClickDialogButton('Save'));
  if (!save?.ok || typeof save.x !== 'number' || typeof save.y !== 'number') {
    throw new GmError('LABEL_RENAME_FAILED', `no Save button in the Edit label dialog: ${save?.miss || 'unknown'}`);
  }
  await trustedAt(cdp, save.x, save.y);
  await sleep(2500);

  // Verify from the page, not from the click: re-read the settings list.
  const after = await cdp.evaluate<ActionPoint>(jsFindLabelAction(dst, 'edit')).catch(() => ({ ok: false }) as ActionPoint);
  return {
    ok: true,
    label: dst,
    verified: after?.ok === true,
    note:
      after?.ok === true
        ? `renamed "${src}" to "${dst}" — confirmed by re-reading the Labels settings page`
        : `clicked Save for "${src}" -> "${dst}", but the renamed label could not be re-read; confirm with gmail_labels`,
  };
}

/**
 * Delete a label. The mail keeps existing — only the label goes.
 *
 * MEASURED 2026-08-01: the confirm is `role="alertdialog"` reading
 * "Remove label / Delete the label "X"? / Cancel Delete".
 */
export async function deleteLabel(cdp: LabelCdp, name: string): Promise<LabelOpResult> {
  const target = String(name || '').trim();
  if (!target) throw new GmError('INVALID_LABEL', 'name is required');

  await openLabelDialog(cdp, target, 'remove');
  const del = await cdp.evaluate<ActionPoint>(jsClickDialogButton('Delete'));
  if (!del?.ok || typeof del.x !== 'number' || typeof del.y !== 'number') {
    throw new GmError('LABEL_DELETE_FAILED', `no Delete button in the Remove label dialog: ${del?.miss || 'unknown'}`);
  }
  await trustedAt(cdp, del.x, del.y);
  await sleep(2500);

  // Verify by ABSENCE — a delete that reports success while the label survives is
  // the failure a caller is least likely to notice.
  const still = await cdp.evaluate<ActionPoint>(jsFindLabelAction(target, 'remove')).catch(() => ({ ok: true }) as ActionPoint);
  const gone = still?.ok !== true;
  return {
    ok: true,
    label: target,
    verified: gone,
    note: gone
      ? `deleted "${target}" — confirmed absent from the Labels settings page (the messages it was on are untouched)`
      : `clicked Delete for "${target}" but it is STILL listed; confirm with gmail_labels`,
  };
}

export async function createLabel(cdp: LabelCdp, name: string, opts?: { parent?: string }): Promise<CreateResult> {
  const full = buildCreatePath(name, opts?.parent);
  if (!full) throw new GmError('INVALID_LABEL', 'name is required');

  const loc = await readLocation(cdp);
  if (!loc.onGmail) {
    throw new GmError('NOT_ON_GMAIL', `the driver browser is on "${loc.host || 'about:blank'}", not mail.google.com.`);
  }

  const existing = await readNavLabels(cdp);
  const already = existing.find((l) => normalizeLabelKey(l.name) === normalizeLabelKey(full));
  if (already) return { ok: true, created: already.name, verified: true };

  const entry = await cdp.evaluate<CtlClick>(jsClickCtl(CREATE_ENTRY_STRATEGIES));
  if (!entry.ok) {
    throw new GmError(
      'CREATE_ENTRY_NOT_FOUND',
      `could not find a "Create new label" control — tried ${CREATE_ENTRY_STRATEGIES.map((s) => s.name).join(', ')}. ` +
        'All are CANDIDATE selectors; capture the nav DOM and add the real one to CREATE_ENTRY_STRATEGIES.',
    );
  }

  const opened = await waitFor(
    cdp,
    `const d = [...document.querySelectorAll(${JSON.stringify(LABEL_SELECTORS.dialog)})]
       .filter((e) => e.offsetParent !== null && e.getBoundingClientRect().height > 0).pop();
     return !!d && !!d.querySelector(${JSON.stringify(LABEL_SELECTORS.dialogTextInput)});`,
    8000,
  );
  if (!opened) {
    throw new GmError(
      'CREATE_DIALOG_NOT_OPEN',
      `clicked the create control (strategy "${entry.via}") but no dialog with a text input appeared.`,
    );
  }

  const filled = await cdp.evaluate<{ ok: boolean; value: string | null }>(jsFillDialog(full));
  if (!filled.ok || filled.value !== full) {
    await cdp.evaluate(JS_CLOSE_MENU).catch(() => undefined);
    throw new GmError(
      'CREATE_NAME_NOT_SET',
      `the dialog's name field would not take "${full}" (read back ${JSON.stringify(filled.value)}) — refusing to submit a dialog whose contents are unknown.`,
    );
  }

  const confirm = await cdp.evaluate<CtlClick>(JS_DIALOG_CONFIRM);
  if (!confirm.ok) {
    await cdp.evaluate(JS_CLOSE_MENU).catch(() => undefined);
    throw new GmError(
      'CREATE_CONFIRM_NOT_FOUND',
      `filled the create dialog but found no confirm button — tried ${CREATE_CONFIRM_STRATEGIES.map((s) => s.name).join(', ')}.`,
    );
  }
  await sleep(1200);

  // Gmail's own duplicate error is the most authoritative "it already exists"
  // there is — and it satisfies the no-op-success contract exactly.
  const dlg = await cdp.evaluate<DialogRead>(JS_DIALOG_STATE);
  if (dlg.open && /already exist|already in use|duplicate/i.test(dlg.text)) {
    await cdp.evaluate(JS_CLOSE_MENU).catch(() => undefined);
    return { ok: true, created: full, verified: true };
  }
  if (dlg.open && dlg.hasInput) {
    await cdp.evaluate(JS_CLOSE_MENU).catch(() => undefined);
    throw new GmError(
      'CREATE_REJECTED',
      `Gmail kept the create dialog open after Create — it did not accept "${full}". Dialog said: ${dlg.text.slice(0, 200) || '(no text)'}`,
    );
  }

  // Verify by re-reading the nav.
  const deadline = Date.now() + 8000;
  for (;;) {
    const nav = await readNavLabels(cdp);
    if (nav.some((l) => normalizeLabelKey(l.name) === normalizeLabelKey(full))) {
      return { ok: true, created: full, verified: true };
    }
    if (Date.now() >= deadline) break;
    await sleep(700);
  }
  // The dialog closed (Gmail accepted) but the nav does not show it. The known
  // benign cause is a nested label under a COLLAPSED parent, whose anchor is
  // never rendered. Report honestly rather than guessing either way.
  return { ok: true, created: full, verified: false };
}

/**
 * Gmail's "move": apply the label AND archive (drop it out of the Inbox).
 *
 * Built from the two verified-by-re-read primitives rather than Gmail's native
 * "Move to" control, whose menu is a second unverified shape. The end state is
 * the same with ONE documented difference: Gmail's native Move-to also strips
 * the thread's other location labels, whereas this adds a label and removes
 * Inbox, leaving any other user labels in place. If that matters, remove them
 * explicitly with removeLabel().
 */
/**
 * Move an archived thread back to the Inbox.
 *
 * MEASURED 2026-07-30: moveToLabel's generic path is "apply the label, then
 * archive" - and in Gmail, archiving IS removing the Inbox label. For the Inbox
 * destination the two steps annihilate and the thread stays exactly where it was,
 * so restoring an archived thread had no working path at all. Gmail's own
 * affordance is the "Move to" control (T-I.J-J5-Ji.T-I-Js-IF) on the LIST toolbar
 * with a row checked, which is what this drives - with trusted events, since that
 * menu ignores synthetic clicks like every other one.
 */
async function moveToInbox(cdp: LabelCdp, threadId: string): Promise<MoveResult> {
  if (!(await selectRowForThread(cdp, threadId))) {
    throw new GmError(
      'ROW_NOT_SELECTABLE',
      'could not check the row for thread ' + threadId + ' in #inbox or #all - the "Move to" menu exists only on the list toolbar with a row selected',
    );
  }
  // MEASURED 2026-07-30: for an ARCHIVED thread Gmail offers a dedicated
  // one-click "Move to Inbox" button (T-I.J-J5-Ji.aFj) and does NOT show the
  // "Move to" menu at all. Prefer it - one trusted click, no menu to drive.
  const direct = await trustedClickControl(cdp, '^move to inbox$');
  let via = 'the "Move to Inbox" button';
  if (!direct.ok) {
    // Fall back to the menu, which is what a thread that is already in the
    // Inbox (or in some other view) shows instead.
    const opened = await trustedClickControl(cdp, '^move to$');
    if (!opened.ok) {
      throw new GmError(
        'MOVE_MENU_NOT_OPEN',
        'neither a "Move to Inbox" button nor a "Move to" menu could be found: ' + (direct.why || '') + ' / ' + (opened.why || ''),
      );
    }
    await sleep(800);
    if (!(await trustedClickMenuRow(cdp, 'Inbox'))) {
      await closeMenu(cdp);
      throw new GmError('MOVE_TARGET_NOT_FOUND', 'the "Move to" menu opened but no Inbox row could be clicked');
    }
    via = 'the "Move to" menu';
  }
  await sleep(1300);
  const toast = await readToast(cdp);
  await closeMenu(cdp);
  return {
    ok: true,
    verified: false,
    note: 'moved to Inbox via ' + via + (toast ? '; toast="' + toast.slice(0, 80) + '"' : '; no toast matched') + ' - confirm with a listing of #inbox',
  };
}

/**
 * Restore a thread from Trash.
 *
 * MEASURED 2026-08-01: `move-to {label:"inbox"}` on a trashed thread fails with
 * ROW_NOT_SELECTABLE, because selectRowForThread only looked in #inbox and #all
 * and Gmail's All Mail EXCLUDES Trash. The machinery was already right — only the
 * view it searched was wrong. So this is moveToInbox scoped to #trash, reusing
 * the same trusted-click path that every other Gmail menu needs.
 *
 * Trash shows a dedicated "Move to Inbox" button for a selected row; the "Move to"
 * menu is the fallback for accounts/locales that render it differently.
 */
export async function untrashThread(cdp: LabelCdp, threadId: string): Promise<MoveResult> {
  if (!(await selectRowForThread(cdp, threadId, ['#trash']))) {
    throw new GmError(
      'ROW_NOT_SELECTABLE',
      'could not check the row for thread ' +
        threadId +
        ' in #trash — it may not be in Trash at all (a permanently deleted thread is unrecoverable), or it is older than the rendered page',
    );
  }
  const direct = await trustedClickControl(cdp, '^move to inbox$');
  let via = 'the "Move to Inbox" button';
  if (!direct.ok) {
    const opened = await trustedClickControl(cdp, '^move to$');
    if (!opened.ok) {
      throw new GmError(
        'MOVE_MENU_NOT_OPEN',
        'neither a "Move to Inbox" button nor a "Move to" menu could be found in #trash: ' +
          (direct.why || '') +
          ' / ' +
          (opened.why || ''),
      );
    }
    await sleep(800);
    if (!(await trustedClickMenuRow(cdp, 'Inbox'))) {
      await closeMenu(cdp);
      throw new GmError('MOVE_TARGET_NOT_FOUND', 'the "Move to" menu opened but no Inbox row could be clicked');
    }
    via = 'the "Move to" menu';
  }
  await sleep(1300);
  const toast = await readToast(cdp);
  await closeMenu(cdp);
  return {
    ok: true,
    verified: false,
    note:
      'restored from Trash via ' +
      via +
      (toast ? '; toast="' + toast.slice(0, 80) + '"' : '; no toast matched') +
      ' - confirm with a listing of #inbox',
  };
}

/**
 * A thread's labels, read from the Labels MENU.
 *
 * 🔴 This replaces chip-scraping, which does not work. MEASURED 2026-08-02 in a
 * single page evaluation (so both readings describe the same rows at the same
 * instant): a row whose DOM carried `["HY: Microsoft"]` came back from the row
 * extractor as `[]`. The thread-view chip path was empty for the same threads.
 * `labels: []` was therefore indistinguishable from "this thread has no labels" —
 * wrong in the worst way, because it reads as a fact.
 *
 * The Labels menu is the UI's OWN answer: every label is a
 * `role="menuitemcheckbox"` carrying `aria-checked`, and the checked ones are
 * exactly this thread's labels. Measured 2026-08-03. It needs no index, cannot go
 * stale, and asks Gmail the question directly instead of inferring it.
 *
 * Costs one menu open per thread, so it is a per-thread call — not something a
 * list read does for every row.
 */
export async function readThreadLabelsViaMenu(cdp: LabelCdp, threadId: string): Promise<string[]> {
  const id = String(threadId || '').trim();
  if (!id) throw new GmError('INVALID_THREAD', 'threadId is required');
  if (!(await selectRowForThread(cdp, id, ['#inbox', '#all']))) {
    throw new GmError(
      'ROW_NOT_SELECTABLE',
      `could not check the row for thread ${id} in #inbox or #all — the Labels menu only exists on the list toolbar with a row selected`,
    );
  }
  const opened = await trustedClickControl(cdp, '^labels?$');
  if (!opened.ok) {
    throw new GmError('LABELS_MENU_NOT_OPEN', `the Labels control did not open: ${opened.why || 'unknown'}`);
  }
  await sleep(900);
  const names = await cdp.evaluate<string[]>(`
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.offsetParent !== null; };
    const menu = [...document.querySelectorAll('div[role="menu"]')].filter(vis).pop();
    if (!menu) return [];
    return [...menu.querySelectorAll('div[role="menuitemcheckbox"]')]
      .filter(vis)
      .filter((e) => e.getAttribute('aria-checked') === 'true')
      // 🔴 textContent, NOT innerText. MEASURED 2026-08-03: Gmail wraps the
      // type-ahead-matched character in an inline element, and innerText is
      // LAYOUT-AWARE — it inserts whitespace at that boundary, so "HY: Microsoft"
      // came back as "HY: Micro oft", the s replaced by a space. textContent
      // concatenates text nodes verbatim. (The reverse hazard is real too: for
      // attachment names textContent LOSES a needed newline. Per-surface choice.)
      .map((e) => String(e.textContent || '').replace(/\\s+/g, ' ').trim())
      .filter(Boolean);`);
  await closeMenu(cdp);
  return Array.isArray(names) ? [...new Set(names)] : [];
}

export async function moveToLabel(cdp: LabelCdp, threadId: string, label: string): Promise<MoveResult> {
  // Inbox is not a label you can apply - it is a system view, absent from the
  // Labels menu, and "apply then archive" cancels itself for it. See moveToInbox.
  if (/^inbox$/i.test(String(label || '').trim())) return moveToInbox(cdp, threadId);

  const applied = await setThreadLabel(cdp, threadId, label, 'on');
  const trace: string[] = [`apply: ${applied.note}`];

  await openThread(cdp, threadId);
  const beforeArchive = await readThreadChips(cdp, threadId);
  const inInbox = beforeArchive.labels.some((l) => /^inbox$/i.test(l.trim()));
  const chipsAlive = beforeArchive.labels.length > 0;

  const arch = await cdp.evaluate<CtlClick>(jsClickCtl(ARCHIVE_BUTTON_STRATEGIES));
  if (!arch.ok) {
    // No Archive control. If the chips are alive and show no Inbox, the thread
    // is already out of the Inbox and there is nothing to do.
    if (chipsAlive && !inInbox) {
      return {
        ok: true,
        verified: applied.verified,
        note: `${trace.join(' | ')} | archive: skipped — the thread is not in the Inbox (chips=${beforeArchive.labels.join(' / ')})`,
      };
    }
    throw new GmError(
      'ARCHIVE_CONTROL_NOT_FOUND',
      `the label was applied to ${threadId}, but no Archive control was found, so the thread was NOT moved out of the Inbox — ` +
        `tried ${ARCHIVE_BUTTON_STRATEGIES.map((s) => s.name).join(', ')}. The label write stands; the move is incomplete.`,
    );
  }
  trace.push(`archive-btn=${arch.via}`);
  await sleep(1200);
  const toast = await readToast(cdp);
  if (toast) trace.push(`toast="${toast.slice(0, 80)}"`);

  const after = await readThreadChips(cdp, threadId, { force: true });
  const stillInInbox = after.labels.some((l) => /^inbox$/i.test(l.trim()));
  let archived: boolean;
  let how: string;
  if (after.labels.length > 0) {
    archived = !stillInInbox;
    how = archived ? 'chips-no-inbox' : 'chips-STILL-inbox';
  } else if (toast && /archiv/i.test(toast)) {
    archived = true;
    how = 'toast-only(chips blind)';
  } else {
    archived = false;
    how = 'unobserved(chips blind, no toast)';
  }
  if (after.labels.length > 0 && stillInInbox) {
    throw new GmError(
      'ARCHIVE_UNVERIFIED',
      `the label was applied, but the thread is STILL in the Inbox after clicking Archive (chips=${after.labels.join(' / ')}).`,
    );
  }
  trace.push(`archived=${archived} (${how})`);
  trace.push('note: unlike Gmail\'s native "Move to", other user labels on this thread were left in place');

  return { ok: true, verified: applied.verified && archived, note: trace.join(' | ') };
}

// ─── test hook ───────────────────────────────────────────────────────────────

/**
 * The page snippets, exported for the offline fake-DOM harness.
 *
 * Not part of the connector's API and not for callers: these are strings meant
 * for `cdp.evaluate`. They are exported because the alternative — testing DOM
 * logic only against a live Gmail — is how unverified selectors ship. Every
 * snippet here is exercised against a hand-built DOM covering the two hazards
 * that have actually bitten this connector: retained hidden view containers, and
 * `.at` returning toolbar controls on a list view.
 */
export const __pageSnippets = {
  JS_LOCATION,
  JS_NAV_LABELS,
  JS_THREAD_CHIPS,
  JS_MENU_STATE,
  JS_MENU_ITEMS,
  JS_MENU_APPLY,
  JS_CLOSE_MENU,
  JS_TOAST,
  JS_DIALOG_STATE,
  JS_DIALOG_CONFIRM,
  jsClickCtl,
  jsSetMenuFilter,
  jsClickMenuItem,
  jsFillDialog,
  jsGotoHash,
  LABELS_BUTTON_STRATEGIES,
  ARCHIVE_BUTTON_STRATEGIES,
  CREATE_ENTRY_STRATEGIES,
} as const;
