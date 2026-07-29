/**
 * Gmail page-side extractors — richer thread detail, list rows, label TREE, and
 * attachments. Written to be pasted into `core/src/gmail/cdp-client.ts`; every
 * snippet is a plain string that runs inside that file's
 * `cdp.evaluate()` wrapper — i.e. the page executes `(async()=>{ <snippet> })()`
 * — so each one MUST `return` a value and MAY use `await`.
 *
 * ── The one non-negotiable rule (MEASURED live 2026-07-29) ───────────────────
 * Gmail RETAINS previous view containers in the DOM. After inbox -> sent ->
 * search there were **3 list tables of 50 rows each (150 rows total), only ONE
 * visible** (height 5000; the other two height 0). A global `querySelectorAll`
 * returns the STALE rows first, so an unscoped read silently answers with the
 * PREVIOUS view's data and looks perfectly successful. Every selector below is
 * therefore resolved through `__vis` / `__visIn`.
 *
 * Attachments are the one deliberate exception, and for a reason: a download
 * anchor can legitimately be zero-height/hidden inside a *visible* message. So
 * attachments are scoped by **container** visibility (the message element is
 * visible-checked) and then read WITHOUT a per-element visibility filter. That
 * keeps the stale-view guarantee while not dropping real links. See __attachIn.
 *
 * ── Evidence policy ──────────────────────────────────────────────────────────
 * Every selector in SELECTORS_EXT is tagged VERIFIED (with the date it was
 * observed live) or CANDIDATE (plausible, NOT observed). Nothing here is
 * presented as measured unless it was. Where a fact is unverified the extractor
 * tries SEVERAL shapes and reports WHICH one matched, so a future breakage is
 * diagnosable from the returned data instead of a silent empty array.
 *
 * ── Merge notes ──────────────────────────────────────────────────────────────
 *  - `JS_VISIBLE` below is byte-identical to the one already in cdp-client.ts.
 *    On merge, DELETE this copy and keep the existing one (two `const __vis`
 *    declarations in one page snippet is a page-side SyntaxError).
 *  - `JS_UTIL` / `JS_ATTACH` are new shared blocks; they deliberately do NOT
 *    declare `__vis`, so each top-level snippet interpolates `JS_VISIBLE`
 *    exactly once, then the helpers.
 *  - `JS_THREAD_ROWS(limit)` is a function (it takes a limit), mirroring the
 *    existing `jsThreadRows(limit)`; rename to taste on merge.
 *  - Every snippet is wrapped in try/catch and returns an EMPTY shape on a miss.
 *    A page-side throw surfaces as PAGE_EVAL_ERROR and tells the caller nothing.
 */

// ─── caps (single source of truth; interpolated into the page code) ──────────

/** Per-message body cap. Matches the existing connector's 20 000-char cap. */
const MAX_BODY_CHARS = 20000;
/** Hard cap on attachments returned per message and per thread scan. */
const MAX_ATTACHMENTS = 20;
/** Recipients per message. Gmail can address a lot of people; this is a floor of sanity. */
const MAX_RECIPIENTS = 50;
/** Label chips per list row / per thread. */
const MAX_LABELS = 12;
/** Snippet text kept per list row. */
const MAX_SNIPPET_CHARS = 200;

// ─── selectors (single source of truth — fix breakage HERE, never inline) ────

export const SELECTORS_EXT = {
  // ── thread list ────────────────────────────────────────────────────────────
  /** VERIFIED 2026-07-29: a thread-list row. Unread rows additionally carry `zE`. */
  threadRow: 'tr.zA',
  /** VERIFIED 2026-07-29: the real server thread id lives on a DESCENDANT of the row. */
  rowThreadId: '[data-legacy-thread-id]',
  /** VERIFIED 2026-07-29: sender chip; carries `email` and `name` attributes. */
  rowSender: '.yX span[email], span[email]',
  /** VERIFIED 2026-07-29: subject cell. */
  rowSubject: '.y6 span',
  /** VERIFIED 2026-07-29: snippet cell (leading em-dash separator is stripped). */
  rowSnippet: '.y2',
  /** VERIFIED 2026-07-29: date; the full timestamp is in `title`. */
  rowDate: 'td.xW span[title], span[title]',
  /**
   * CANDIDATE — the row-level attachment hint. NOT observed: the `has:attachment`
   * probe on 2026-07-29 reached rows but the hint result was never pinned to a
   * specific class. These are tried in order and the WINNER is reported back as
   * `attachHint`, so the first live run tells you which (if any) is real.
   */
  rowAttachHints: [
    '.brd',                          // CANDIDATE: row attachment-name chips
    '.aZo',                          // CANDIDATE: attachment icon span
    '[aria-label*="ttachment" i]',   // CANDIDATE: a11y label ("...has attachment")
    '[title*="ttachment" i]',        // CANDIDATE: tooltip
    'img[src*="attach"]',            // CANDIDATE: sprite/paperclip image
  ] as readonly string[],
  /**
   * CANDIDATE — per-row label chips. The classic Gmail shape is
   * `div.ar.as > div.at[title] > div.av`. Probed 2026-07-29 (`.ar.as .at, .av`)
   * but the result was not preserved, so treat as unconfirmed. Scoped to the ROW,
   * which structurally cannot reach the toolbar.
   */
  rowLabelChip: '.ar.as .at, .at',
  /** CANDIDATE: the visible text node inside a row label chip. */
  rowLabelText: '.av',

  // ── open thread ────────────────────────────────────────────────────────────
  /** VERIFIED 2026-07-29: subject of the open thread; also THE proof we are on a thread view. */
  threadSubject: 'h2.hP',
  /** VERIFIED 2026-07-29: one rendered (expanded) message. */
  msgItem: '.adn.ads',
  /** VERIFIED 2026-07-29: real server message id, on the message container. */
  msgIdHolder: '[data-legacy-message-id]',
  /** VERIFIED 2026-07-29: sender chip inside a message — attributes `name`, `email`. */
  msgSender: '.gD, span[email]',
  /** VERIFIED 2026-07-29: timestamp; full date in `title`. */
  msgDate: '.g3',
  /** VERIFIED 2026-07-29: rendered body. */
  msgBody: '.a3s.aiL, .a3s',
  /**
   * CANDIDATE — recipient chips. `.g2` is the classic recipient span; the robust
   * path this file actually relies on is "every span[email] in the message MINUS
   * the sender", which needs no class at all. NOTE: Gmail renders only the
   * SUMMARY recipients until "show details" is expanded, so `to` can legitimately
   * be short or empty on a collapsed header. Not yet confirmed live.
   */
  msgRecipient: '.g2[email], .hb span[email], span[email]',
  /**
   * INHERITED from cdp-client.ts (in production use since 2026-07-29). Its
   * presence on a collapsed thread was probed but the result was not preserved —
   * treat as unconfirmed and rely on `collapsedCount` to tell you it failed.
   */
  expandAll: '[aria-label="Expand all"], [data-tooltip="Expand all"]',
  /**
   * CANDIDATE — collapsed message stubs. Probed 2026-07-29 as
   * `.kv, .kQ, .adx` ("collapsedRows") but the count was never correlated with a
   * thread of known length. A non-zero `collapsedCount` is a HINT, not a fact.
   */
  collapsedMsg: '.kv, .kQ, .adx',

  // ── thread labels ──────────────────────────────────────────────────────────
  /**
   * VERIFIED 2026-07-29 (values): on a labelled OPEN thread, elements with class
   * `.at` yielded ["DB: Office Supplies", "HY: Zz-Email Test", "HY: Microsoft"].
   * 🔴 VERIFIED HAZARD: the SAME unscoped `.at` on a LIST view returns TOOLBAR
   * junk — "Select", "Archive", "Mark as read", "Snooze". So `.at` is only ever
   * read (a) after `h2.hP` proves a thread is open, (b) scoped to a container
   * below the subject, (c) with the junk filter applied anyway.
   */
  threadLabelChip: '.at',
  /** CANDIDATE — preferred scoped shapes for the thread's label chips, tried first. */
  threadLabelScoped: '.hN .at, .ha .at, .qh .at, .ar.as .at',
  /** VERIFIED HAZARD 2026-07-29: containers whose `.at` nodes are toolbar controls, never labels. */
  labelJunkContainers: '[gh], [role="toolbar"], .G-atb, .G-Ni, .aqK',

  // ── left nav ───────────────────────────────────────────────────────────────
  /**
   * VERIFIED 2026-07-29: label links. 🔴 Must NOT be scoped to
   * `div[role="navigation"]` — that combination matches NOTHING (the anchors sit
   * outside it). Hrefs look like `/mail/u/0/#label/4%29+DB:+AUTHORITIES/ACRA`:
   * labels NEST with `/` and are URL-encoded with `+` for spaces.
   */
  navLabel: 'a[href*="#label/"]',
  /**
   * CANDIDATE — the unread-count BADGE on a nav row. Inherited from
   * cdp-client.ts, never confirmed to yield.
   *
   * 🔴 Narrowed deliberately: the inherited value was `.bsU, [aria-label*="unread" i]`,
   * and the second half is a TRAP. Gmail's nav anchors carry a11y labels like
   * "HY: Microsoft, 12 unread messages", so that selector matches the ANCHOR
   * ITSELF — and reading its textContent returns the LABEL NAME as the unread
   * count. Caught by the fake-DOM harness before it ever ran live. The a11y text
   * is still used, but PARSED with a regex (see the `N unread` match), never read
   * as an element's text.
   */
  navUnread: '.bsU',
  /** CANDIDATE — the nav row wrapping the anchor, searched for the badge when the anchor has none. */
  navRow: '.aim, .TO, div[role="listitem"], li',

  // ── attachments (ALL CANDIDATE — see ATTACH_STRATEGIES) ────────────────────
  /**
   * 🔴 MEASURED 2026-07-29: `.aQH`, `span.aZo` and `.aV3` ALL returned 0 — but on
   * threads that turned out to have NO attachments, so this is a NULL RESULT, not
   * a refutation. They remain unconfirmed in both directions. Nothing below has
   * ever been seen to match a real attachment.
   */
  attachChip: '.aQH, span.aZo, .aV3, .aQy, .aZH',
  /** CANDIDATE — the wrapper Gmail puts the attachment strip in. */
  attachZone: '.hq, .aQH, .aZH',
} as const;

/**
 * Attachment discovery strategies, in priority order. The extractor runs them
 * until one YIELDS, then reports which one won as `strategy` — that is the whole
 * point: with every attachment selector unconfirmed, a silent empty array is
 * indistinguishable from "this thread has no attachments". `tried` carries the
 * per-strategy hit count so a failure is diagnosable from one call.
 *
 * `verified: false` on all of them is not laziness — see SELECTORS_EXT.attachChip.
 */
const ATTACH_STRATEGIES: ReadonlyArray<{ name: string; sel: string; verified: boolean }> = [
  // Real download links are the highest-value shape: they carry BOTH the filename
  // (`download` attr) and a fetchable URL.
  { name: 'download-attr', sel: 'a[download]', verified: false },
  { name: 'href-attid', sel: 'a[href*="attid"]', verified: false },
  { name: 'href-view-att', sel: 'a[href*="view=att"]', verified: false },
  { name: 'href-disposition', sel: 'a[href*="disp=attd"], a[href*="disp=safe"]', verified: false },
  // Chip containers — name only, URL recovered from a nearby anchor if there is one.
  { name: 'chip-aQH', sel: '.aQH .aV3, .aQH .aYy, .aQH > span', verified: false },
  { name: 'chip-aZo', sel: 'span.aZo', verified: false },
  { name: 'chip-aV3', sel: '.aV3', verified: false },
  // Last resort: a11y text. Catches "Download attachment report.pdf".
  { name: 'aria-download', sel: '[aria-label*="ownload" i], [data-tooltip*="ownload" i]', verified: false },
];

// ─── shared page-side helpers ────────────────────────────────────────────────

/**
 * Page-side helper. BYTE-IDENTICAL to the copy already in cdp-client.ts — on
 * merge, keep ONE. See the file header for why every read goes through it.
 */
export const JS_VISIBLE = `
  const __vis = (sel) => [...document.querySelectorAll(sel)]
    .filter(el => el.offsetParent !== null && el.getBoundingClientRect().height > 0);
`;

/**
 * Small page-side utilities shared by the extractors. Declares NO `__vis`, so it
 * composes with JS_VISIBLE without redeclaration.
 *
 * `__JUNK` is seeded with the four toolbar strings MEASURED on a list view
 * (select / archive / mark as read / snooze); the rest are defensive additions
 * covering the same toolbar, NOT observed.
 */
export const JS_UTIL = `
  const __txt = (el) => el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : '';
  const __visIn = (root, sel) => {
    try {
      return [...(root || document).querySelectorAll(sel)]
        .filter(el => el.offsetParent !== null && el.getBoundingClientRect().height > 0);
    } catch (e) { return []; }
  };
  const __all = (root, sel) => {
    try { return [...(root || document).querySelectorAll(sel)]; } catch (e) { return []; }
  };
  const __abs = (h) => { try { return new URL(h, location.href).href; } catch (e) { return h || null; } };
  const __JUNK = new Set([
    'select', 'archive', 'mark as read', 'snooze',
    'mark as unread', 'delete', 'report spam', 'move to', 'labels', 'more',
    'refresh', 'back to inbox', 'add to tasks', 'print all', 'in new window',
    'show details', 'hide details', 'reply', 'reply all', 'forward'
  ]);
  const __isJunkLabel = (t) => !t || __JUNK.has(t.toLowerCase()) || t.length > 120;
  const __inToolbar = (el) => {
    try { return !!(el.closest && el.closest(${JSON.stringify(SELECTORS_EXT.labelJunkContainers)})); }
    catch (e) { return false; }
  };
  const __uniq = (arr) => [...new Set(arr.filter(Boolean))];
`;

/**
 * Attachment extraction, shared by JS_THREAD_FULL (per message) and
 * JS_ATTACHMENTS_IN_THREAD (whole thread). Requires JS_UTIL.
 *
 * Visibility: the CALLER passes an already visible-checked container, and this
 * helper then does NOT filter descendants by visibility — a download anchor is
 * routinely zero-height inside a visible message, and filtering it would drop
 * exactly the shape we most want. The stale-view guarantee is preserved by the
 * container, which is where it belongs.
 */
export const JS_ATTACH = `
  const __ATT_STRATS = ${JSON.stringify(ATTACH_STRATEGIES.map((s) => ({ name: s.name, sel: s.sel })))};
  const __ATT_UI_WORDS = new Set([
    'download', 'download all', 'download all attachments', 'save to drive',
    'add to drive', 'add all to drive', 'preview', 'share', 'view', 'open'
  ]);
  /** Pull a human size out of any text: "(128K)", "1.2 MB", "934 bytes". */
  const __sizeLabel = (t) => {
    if (!t) return null;
    const m = String(t).match(/(\\d+(?:[.,]\\d+)?)\\s*(KB|MB|GB|TB|bytes|K|M|G|B)\\b/i);
    return m ? (m[1] + ' ' + m[2]) : null;
  };
  /** Normalise one candidate element into {name, sizeLabel, downloadUrl} or null. */
  const __attFrom = (el) => {
    try {
      const isAnchor = el.tagName === 'A' && el.getAttribute('href');
      const a = isAnchor ? el
        : (__all(el, 'a[download], a[href*="attid"], a[href*="view=att"], a[href]')[0]
           || (el.closest ? el.closest('a[href]') : null));
      const downloadUrl = a ? __abs(a.getAttribute('href')) : null;
      const raw = el.getAttribute('aria-label') || el.getAttribute('data-tooltip')
        || el.getAttribute('title') || __txt(el);
      let name = el.getAttribute('download') || (a ? a.getAttribute('download') : null) || '';
      if (!name) {
        // MEASURED 2026-07-29 on a real a[href*="attid"] anchor:
        //   download / aria-label / title are all NULL, and
        //   innerText   = "Preview attachment <filename>\\nPreview attachment <filename>…"
        //   textContent = "<filename>Preview attachment <filename>…"   <- newline LOST
        // So take innerText's FIRST LINE and strip the label. textContent must not
        // be used here: it joins adjacent elements with no separator (the same trap
        // that silently emptied the send-as parser).
        const __firstLine = String((el.innerText || '') || raw || '').split('\\n')[0].trim();
        const __label = /^\\s*(?:preview|download|open)?\\s*attachment\\s+/i;
        name = __firstLine.replace(__label, '').trim()
          || String(raw || '').split(',')[0].trim().replace(/^(Download|Preview|Open)\\s+/i, '');
      }
      name = name.trim();
      if (!name || __ATT_UI_WORDS.has(name.toLowerCase())) return null;
      if (name.length > 200) name = name.slice(0, 200);
      return { name, sizeLabel: __sizeLabel(raw) || __sizeLabel(__txt(el)), downloadUrl: downloadUrl || null };
    } catch (e) { return null; }
  };
  /**
   * Run every strategy against \`root\`; return the FIRST that yields, plus the
   * full per-strategy hit table so a zero result is diagnosable.
   */
  const __attachIn = (root) => {
    const tried = [];
    let winner = null, items = [];
    for (const st of __ATT_STRATS) {
      let found = [];
      try {
        const seen = new Set();
        for (const el of __all(root, st.sel)) {
          const rec = __attFrom(el);
          if (!rec) continue;
          const key = rec.name + '|' + (rec.downloadUrl || '');
          if (seen.has(key)) continue;
          seen.add(key);
          found.push(rec);
          if (found.length >= ${MAX_ATTACHMENTS}) break;
        }
      } catch (e) { found = []; }
      tried.push({ strategy: st.name, count: found.length });
      if (!winner && found.length) { winner = st.name; items = found; }
    }
    return { strategy: winner, attachments: items.slice(0, ${MAX_ATTACHMENTS}), tried };
  };
`;

// ─── 1. JS_THREAD_FULL — open-thread extraction ──────────────────────────────

/**
 * Full detail for the currently OPEN thread.
 *
 * Returns `{ subject, labels, messages: [{ messageId, fromName, fromEmail, to,
 * date, body, attachments }], collapsedCount }`.
 *
 * Behaviour:
 *  - clicks "Expand all" FIRST when that control exists, waits, then reads — so a
 *    long thread's bodies are actually in the DOM;
 *  - works for a single-message thread (no expand control, one `.adn.ads`);
 *  - visible-scoped throughout: with two threads' containers retained, an
 *    unscoped read merges messages from a previously opened thread;
 *  - `collapsedCount` reports stubs STILL collapsed after the attempt, which is
 *    how a caller learns the expansion silently failed instead of trusting a
 *    short `messages` array;
 *  - `labels` is read ONLY once `h2.hP` proves a thread view, scoped below the
 *    subject, and junk-filtered — because the same `.at` class is toolbar
 *    controls on a list view (MEASURED).
 *  - never throws: returns the empty shape on any failure.
 */
export const JS_THREAD_FULL = `
  ${JS_VISIBLE}
  ${JS_UTIL}
  ${JS_ATTACH}
  const __empty = { subject: null, labels: [], messages: [], collapsedCount: 0, observedThreadIds: [], url: location.href };
  try {
    // ── 0. expand-all, if this thread is collapsed ──────────────────────────
    try {
      const exp = __vis(${JSON.stringify(SELECTORS_EXT.expandAll)})[0]
        || document.querySelector(${JSON.stringify(SELECTORS_EXT.expandAll)});
      if (exp) { exp.click(); await new Promise(r => setTimeout(r, 900)); }
    } catch (e) { /* a missing expand control is normal on a 1-message thread */ }

    // ── 1. subject — also the proof we are on a thread view ─────────────────
    const subjEl = __vis(${JSON.stringify(SELECTORS_EXT.threadSubject)})[0]
      || document.querySelector(${JSON.stringify(SELECTORS_EXT.threadSubject)});
    if (!subjEl) return __empty;           // not a thread view: refuse to guess
    const subject = __txt(subjEl) || null;

    // ── 2. thread labels ────────────────────────────────────────────────────
    // Strategy A: the scoped shapes. Strategy B: walk UP from the subject and
    // take the first ancestor that carries .at nodes — structurally cannot reach
    // the toolbar, which sits above the thread container. Strategy C: global .at,
    // only reachable because subjEl already proved a thread view, and still
    // junk-filtered. All three drop anything inside a toolbar container.
    const __readLabels = (nodes) => __uniq(nodes
      .filter(el => !__inToolbar(el))
      .map(el => (el.getAttribute('title') || el.getAttribute('data-tooltip')
        || __txt(el.querySelector(${JSON.stringify(SELECTORS_EXT.rowLabelText)})) || __txt(el)).trim())
      .filter(t => !__isJunkLabel(t)))
      .slice(0, ${MAX_LABELS});
    let labels = __readLabels(__visIn(document, ${JSON.stringify(SELECTORS_EXT.threadLabelScoped)}));
    if (!labels.length) {
      let node = subjEl;
      for (let i = 0; i < 4 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        const hits = __visIn(node, ${JSON.stringify(SELECTORS_EXT.threadLabelChip)});
        if (hits.length) { labels = __readLabels(hits); break; }
      }
    }
    if (!labels.length) {
      labels = __readLabels(__visIn(document, ${JSON.stringify(SELECTORS_EXT.threadLabelChip)}));
    }

    // ── 3. messages ─────────────────────────────────────────────────────────
    let msgEls = __vis(${JSON.stringify(SELECTORS_EXT.msgItem)});
    if (!msgEls.length) {
      // Fallback: message containers carry the real id even if .adn.ads changes.
      msgEls = __visIn(document, ${JSON.stringify(SELECTORS_EXT.msgIdHolder)});
    }
    const messages = [];
    for (const m of msgEls) {
      const holder = (m.closest && m.closest(${JSON.stringify(SELECTORS_EXT.msgIdHolder)}))
        || m.querySelector(${JSON.stringify(SELECTORS_EXT.msgIdHolder)});
      const s = m.querySelector(${JSON.stringify(SELECTORS_EXT.msgSender)});
      const b = m.querySelector(${JSON.stringify(SELECTORS_EXT.msgBody)});
      const d = m.querySelector(${JSON.stringify(SELECTORS_EXT.msgDate)});
      const fromEmail = s ? s.getAttribute('email') : null;
      // Recipients: every addressed span in the message MINUS the sender. This
      // needs no class name, so it survives a class rename. CAVEAT (unverified):
      // Gmail renders only summary recipients until "show details" is expanded,
      // so a short or empty \`to\` is expected on a collapsed header.
      const to = __uniq(__all(m, ${JSON.stringify(SELECTORS_EXT.msgRecipient)})
        .map(x => x.getAttribute('email'))
        .filter(e => e && e !== fromEmail)).slice(0, ${MAX_RECIPIENTS});
      // Attachments: scope to the message CONTAINER (already visible-checked),
      // then read without a per-element visibility filter — see JS_ATTACH.
      const att = __attachIn(holder || m);
      messages.push({
        messageId: holder ? holder.getAttribute(${JSON.stringify('data-legacy-message-id')}) : null,
        fromName: s ? (s.getAttribute('name') || __txt(s) || null) : null,
        fromEmail: fromEmail,
        to: to,
        date: d ? (d.getAttribute('title') || __txt(d) || null) : null,
        body: b ? String(b.innerText || '').trim().slice(0, ${MAX_BODY_CHARS}) : '',
        attachments: att.attachments,
        attachmentStrategy: att.strategy
      });
    }

    // ── 4. how much did NOT expand ──────────────────────────────────────────
    // Stubs that still hold no rendered body. CANDIDATE selectors — treat a
    // non-zero value as "expansion may have failed here", not as a message count.
    let collapsedCount = 0;
    try {
      collapsedCount = __visIn(document, ${JSON.stringify(SELECTORS_EXT.collapsedMsg)})
        .filter(el => !el.querySelector('.a3s')).length;
    } catch (e) { collapsedCount = 0; }

    // The data-legacy-thread-id values actually RENDERED, scoped to the open
    // conversation and visible-only. Identity was previously provable only from
    // message ids, and a thread id equals its first message id for RECEIVED mail
    // but NOT for mail the account sent itself — so on a self-sent thread the
    // check had no valid evidence and failed a correct read. Gmail also keeps the
    // list mounted behind the conversation, hence the scoping.
    let observedThreadIds = [];
    try {
      const __hdr = __vis("h2.hP")[0];
      const __root = (__hdr && __hdr.closest('div[role="main"]')) || document;
      observedThreadIds = [...new Set(
        [...__root.querySelectorAll('[data-legacy-thread-id]')]
          .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && n.offsetParent !== null; })
          .map((n) => n.getAttribute('data-legacy-thread-id'))
          .filter(Boolean),
      )];
    } catch (err) { observedThreadIds = []; }
    return { subject, labels, messages, collapsedCount, observedThreadIds, url: location.href };
  } catch (e) {
    return __empty;
  }`;

// ─── 2. JS_THREAD_ROWS — list rows ───────────────────────────────────────────

/**
 * Thread-list rows for the CURRENTLY VISIBLE view, capped at `limit`.
 *
 * Adds to the existing row shape:
 *  - `hasAttachments` + `attachHint` — WHICH hint selector matched (null when
 *    none did). With every attachment selector unconfirmed, a bare `false` is
 *    indistinguishable from a broken selector; the hint name makes it diagnosable
 *    in one call against a `has:attachment` search.
 *  - `labels` — per-row chips, scoped to the row (which structurally cannot
 *    reach the toolbar) and junk-filtered anyway.
 *
 * Visible-scoped: this is THE call the retained-container hazard breaks — an
 * unscoped read returns the previous view's 50 rows, in full, looking correct.
 */
export function JS_THREAD_ROWS(limit: number): string {
  const n = Math.max(1, Math.min(Math.floor(limit) || 25, 100));
  return `
  ${JS_VISIBLE}
  ${JS_UTIL}
  try {
    const HINTS = ${JSON.stringify(SELECTORS_EXT.rowAttachHints)};
    const rows = __vis(${JSON.stringify(SELECTORS_EXT.threadRow)}).slice(0, ${n});
    return rows.map(tr => {
      const idEl = tr.querySelector(${JSON.stringify(SELECTORS_EXT.rowThreadId)});
      const s = tr.querySelector(${JSON.stringify(SELECTORS_EXT.rowSender)});
      const subj = tr.querySelector(${JSON.stringify(SELECTORS_EXT.rowSubject)});
      const snip = tr.querySelector(${JSON.stringify(SELECTORS_EXT.rowSnippet)});
      const when = tr.querySelector(${JSON.stringify(SELECTORS_EXT.rowDate)});
      let attachHint = null;
      for (const h of HINTS) {
        let hit = null;
        try { hit = tr.querySelector(h); } catch (e) { hit = null; }
        if (hit) { attachHint = h; break; }
      }
      const labels = __uniq(__all(tr, ${JSON.stringify(SELECTORS_EXT.rowLabelChip)})
        .filter(el => !__inToolbar(el))
        .map(el => (el.getAttribute('title') || el.getAttribute('data-tooltip')
          || __txt(el.querySelector(${JSON.stringify(SELECTORS_EXT.rowLabelText)})) || __txt(el)).trim())
        .filter(t => !__isJunkLabel(t))).slice(0, ${MAX_LABELS});
      return {
        threadId: idEl ? idEl.getAttribute('data-legacy-thread-id') : null,
        unread: tr.classList.contains('zE'),
        fromEmail: s ? s.getAttribute('email') : null,
        fromName: s ? (s.getAttribute('name') || __txt(s) || null) : null,
        subject: subj ? __txt(subj) : null,
        snippet: snip ? __txt(snip).replace(/^\\s*[-\\u2010-\\u2015]\\s*/, '').slice(0, ${MAX_SNIPPET_CHARS}) : null,
        date: when ? (when.getAttribute('title') || __txt(when) || null) : null,
        hasAttachments: !!attachHint,
        attachHint: attachHint,
        labels: labels
      };
    });
  } catch (e) {
    return [];
  }`;
}

// ─── 3. JS_LABELS — the full label tree ──────────────────────────────────────

/**
 * The label TREE from the left nav: `[{ name, path, nested, unread }]`.
 *
 * MEASURED 2026-07-29: hrefs look like `/mail/u/0/#label/4%29+DB:+AUTHORITIES/ACRA`
 * — labels NEST with `/` and encode spaces as `+`. So:
 *  - SPLIT on `/` FIRST, then decode each segment. Decoding first would turn a
 *    `%2F` inside a label name into a false nesting separator.
 *  - `+` -> space per segment BEFORE decodeURIComponent (decodeURIComponent does
 *    NOT do the `+` substitution — that is a form-encoding rule).
 *  - decodeURIComponent throws on a malformed `%`; every decode is guarded.
 *
 * MEASURED 2026-07-29: the anchors must NOT be scoped to `div[role="navigation"]`
 * — that combination matches NOTHING.
 *
 * Visibility: nav-first through `__vis`, with an UNSCOPED fallback. Unlike list
 * tables there is exactly ONE nav, so there are no stale duplicates to confuse;
 * the visible filter only exists to prefer an expanded rail, and falling back
 * keeps labels readable when the rail is collapsed (offsetParent null).
 */
export const JS_LABELS = `
  ${JS_VISIBLE}
  ${JS_UTIL}
  try {
    const dec = (s) => { try { return decodeURIComponent(String(s).replace(/\\+/g, ' ')); } catch (e) { return String(s).replace(/\\+/g, ' '); } };
    let anchors = __vis(${JSON.stringify(SELECTORS_EXT.navLabel)});
    if (!anchors.length) anchors = __all(document, ${JSON.stringify(SELECTORS_EXT.navLabel)});
    const seen = new Set();
    const out = [];
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/#label\\/([^?#]+)/);
      if (!m) continue;
      const path = m[1].split('/').map(dec).map(x => x.trim()).filter(Boolean);
      if (!path.length) continue;
      const name = path.join('/');
      if (seen.has(name)) continue;
      seen.add(name);
      // Unread count. THREE guarded strategies — all CANDIDATE. Every one of them
      // insists the value LOOKS like a count, because the failure mode here is not
      // "no count", it is "the label name silently reported as a count".
      let unread = null;
      try {
        const isCount = (t) => /^[\\d,]+\\+?$/.test(String(t || '').trim());
        const row = (a.closest && a.closest(${JSON.stringify(SELECTORS_EXT.navRow)})) || a.parentElement;
        // (a) the classic badge element, inside the anchor or its row.
        const badge = a.querySelector(${JSON.stringify(SELECTORS_EXT.navUnread)})
          || (row ? row.querySelector(${JSON.stringify(SELECTORS_EXT.navUnread)}) : null);
        if (badge && isCount(__txt(badge))) unread = __txt(badge);
        // (b) parse "N unread" out of a11y text. NEVER read that element's text —
        // the element carrying it is usually the anchor, whose text is the NAME.
        if (!unread) {
          for (const s of [a.getAttribute('aria-label'), a.getAttribute('title'),
                           row ? row.getAttribute('aria-label') : null]) {
            const um = String(s || '').match(/([\\d,]+)\\s*unread/i);
            if (um) { unread = um[1]; break; }
          }
        }
        // (c) class-free fallback: a purely numeric element in the row that is
        // NOT the anchor, not inside it, and does not contain it — which is where
        // Gmail puts the count when the badge class has been renamed. The
        // containment guards are what stop a label literally named "2024" from
        // reporting itself as 2024 unread.
        if (!unread && row) {
          for (const el of __all(row, '*')) {
            if (el === a || (a.contains && a.contains(el)) || (el.contains && el.contains(a))) continue;
            if (isCount(__txt(el))) { unread = __txt(el); break; }
          }
        }
      } catch (e) { unread = null; }
      out.push({ name, path, nested: path.length > 1, unread });
    }
    return out;
  } catch (e) {
    return [];
  }`;

// ─── 4. JS_ATTACHMENTS_IN_THREAD — standalone attachment scan ────────────────

/**
 * Standalone attachment extractor for the OPEN thread. Runs every strategy in
 * ATTACH_STRATEGIES and returns the first that yields, naming it in `strategy`.
 *
 * Returns `{ strategy, scopedTo, attachments: [{ name, sizeLabel, downloadUrl,
 * messageId }], tried: [{ strategy, count }] }`.
 *
 * 🔴 EVERY selector here is a CANDIDATE. On 2026-07-29 `.aQH`, `span.aZo` and
 * `.aV3` all returned 0 — but only on threads that HAD no attachments, so that
 * is a null result, not a refutation. Nothing in this extractor has been seen to
 * match a real attachment. `tried` exists exactly so the first live run against
 * `has:attachment` tells you which shape is real in one call, rather than leaving
 * you to guess from an empty array.
 *
 * Scope: visible message containers first (stale-view safe), then the visible
 * thread container, then the document as a LAST resort — `scopedTo` says which,
 * because a document-scoped hit is the one result you should not trust.
 */
export const JS_ATTACHMENTS_IN_THREAD = `
  ${JS_VISIBLE}
  ${JS_UTIL}
  ${JS_ATTACH}
  const __empty = { strategy: null, scopedTo: 'none', attachments: [], tried: [] };
  try {
    const subjEl = __vis(${JSON.stringify(SELECTORS_EXT.threadSubject)})[0];
    // Per-message scan first: it is stale-view safe AND attributes each file to
    // the message it came from, which a document-wide scan cannot do.
    let msgEls = __visIn(document, ${JSON.stringify(SELECTORS_EXT.msgIdHolder)});
    if (!msgEls.length) msgEls = __vis(${JSON.stringify(SELECTORS_EXT.msgItem)});
    const tried = {};
    const out = [];
    let strategy = null;
    for (const m of msgEls) {
      const r = __attachIn(m);
      for (const t of r.tried) tried[t.strategy] = (tried[t.strategy] || 0) + t.count;
      if (r.strategy && !strategy) strategy = r.strategy;
      const mid = m.getAttribute ? m.getAttribute('data-legacy-message-id') : null;
      for (const a of r.attachments) {
        if (out.length >= ${MAX_ATTACHMENTS}) break;
        out.push({ name: a.name, sizeLabel: a.sizeLabel, downloadUrl: a.downloadUrl, messageId: mid });
      }
      if (out.length >= ${MAX_ATTACHMENTS}) break;
    }
    const table = Object.keys(tried).map(k => ({ strategy: k, count: tried[k] }));
    if (out.length) return { strategy, scopedTo: 'messages', attachments: out, tried: table };

    // Nothing per message. Widen to the visible thread container (still scoped),
    // then to the document — flagged, because a document hit can be another view.
    if (subjEl) {
      let node = subjEl;
      for (let i = 0; i < 5 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        const r = __attachIn(node);
        if (r.strategy) {
          return { strategy: r.strategy, scopedTo: 'thread-container',
                   attachments: r.attachments.map(a => ({ name: a.name, sizeLabel: a.sizeLabel, downloadUrl: a.downloadUrl, messageId: null })),
                   tried: r.tried };
        }
      }
    }
    const doc = __attachIn(document);
    if (doc.strategy) {
      return { strategy: doc.strategy, scopedTo: 'document-UNSCOPED',
               attachments: doc.attachments.map(a => ({ name: a.name, sizeLabel: a.sizeLabel, downloadUrl: a.downloadUrl, messageId: null })),
               tried: doc.tried };
    }
    return { strategy: null, scopedTo: msgEls.length ? 'messages' : 'none', attachments: [], tried: table.length ? table : doc.tried };
  } catch (e) {
    return __empty;
  }`;

// ─── result types (for the cdp-client public API when these are merged) ──────

export interface GmailAttachment {
  name: string;
  sizeLabel: string | null;
  downloadUrl: string | null;
  /** Present only on JS_ATTACHMENTS_IN_THREAD results. */
  messageId?: string | null;
}

export interface GmailMessageFull {
  messageId: string | null;
  fromName: string | null;
  fromEmail: string | null;
  to: string[];
  date: string | null;
  body: string;
  attachments: GmailAttachment[];
  /** Which ATTACH_STRATEGIES entry produced `attachments` (null = none matched). */
  attachmentStrategy: string | null;
}

export interface GmailThreadFull {
  subject: string | null;
  labels: string[];
  messages: GmailMessageFull[];
  /** Stubs still collapsed AFTER the expand-all attempt. Non-zero = suspect the expansion. */
  collapsedCount: number;
  /**
   * The data-legacy-thread-id values the OPEN conversation actually renders.
   *
   * Evidence for assertThreadMatches. Message ids alone are not enough: a thread
   * id equals its first message id for RECEIVED mail but not for mail the account
   * sent itself, so identity was only ever provable by coincidence.
   */
  observedThreadIds: string[];
  url: string;
}

export interface GmailThreadRowFull {
  threadId: string | null;
  unread: boolean;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  snippet: string | null;
  date: string | null;
  hasAttachments: boolean;
  /** Which hint selector matched — null when none did (i.e. also when the selector is wrong). */
  attachHint: string | null;
  labels: string[];
}

export interface GmailLabelNode {
  /** Full label name, nesting joined with `/` (e.g. `4) DB: AUTHORITIES/ACRA`). */
  name: string;
  /** Decoded nesting segments. */
  path: string[];
  nested: boolean;
  unread: string | null;
}

export interface GmailAttachmentScan {
  strategy: string | null;
  scopedTo: 'messages' | 'thread-container' | 'document-UNSCOPED' | 'none';
  attachments: GmailAttachment[];
  tried: Array<{ strategy: string; count: number }>;
}
